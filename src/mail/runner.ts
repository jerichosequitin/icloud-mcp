import { MailAdapterError, MailRunnerError } from './errors';
import { getMailScript } from './scripts';
import { MAIL_LIMITS, type MailOperation } from './types';

export interface MailScriptInvocation {
  arguments: readonly string[];
  operation: MailOperation;
}

export interface MailScriptRunner {
  run(invocation: MailScriptInvocation): Promise<string>;
}

interface SpawnedProcess {
  exited: Promise<number>;
  kill(): void;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

export type MailProcessSpawner = (command: readonly string[]) => SpawnedProcess;

export interface AppleScriptRunnerOptions {
  executionMilliseconds?: number;
  spawn?: MailProcessSpawner;
  stderrBytes?: number;
  stdoutBytes?: number;
}

function defaultSpawn(command: readonly string[]): SpawnedProcess {
  const process = Bun.spawn([...command], {
    stdin: 'ignore',
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exited: process.exited,
    kill: () => process.kill(),
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  byteLimit: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) {
        onLimit();
        throw new MailRunnerError('OUTPUT_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

export class AppleScriptMailRunner implements MailScriptRunner {
  readonly #executionMilliseconds: number;
  readonly #spawn: MailProcessSpawner;
  readonly #stderrBytes: number;
  readonly #stdoutBytes: number;

  constructor(options: AppleScriptRunnerOptions = {}) {
    this.#executionMilliseconds =
      options.executionMilliseconds ?? MAIL_LIMITS.executionMilliseconds;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#stderrBytes = options.stderrBytes ?? MAIL_LIMITS.stderrBytes;
    this.#stdoutBytes = options.stdoutBytes ?? MAIL_LIMITS.stdoutBytes;
  }

  async run(invocation: MailScriptInvocation): Promise<string> {
    const script = getMailScript(invocation.operation);
    if (invocation.arguments.some((argument) => argument.includes('\0'))) {
      throw new MailAdapterError('INVALID_INPUT');
    }
    let process: SpawnedProcess;
    try {
      process = this.#spawn([
        '/usr/bin/osascript',
        '-l',
        'AppleScript',
        '-e',
        script,
        '--',
        ...invocation.arguments,
      ]);
    } catch {
      throw new MailRunnerError('PROCESS_FAILURE');
    }

    let timedOut = false;
    let exceededOutput = false;
    const killForOutputLimit = () => {
      exceededOutput = true;
      process.kill();
    };
    let rejectTimeout: ((error: MailRunnerError) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
      rejectTimeout?.(new MailRunnerError('TIMEOUT'));
    }, this.#executionMilliseconds);

    try {
      const [stdoutResult, stderrResult, exitCode] = await Promise.race([
        Promise.all([
          readBounded(process.stdout, this.#stdoutBytes, killForOutputLimit),
          readBounded(process.stderr, this.#stderrBytes, killForOutputLimit),
          process.exited,
        ]),
        timeout,
      ]);
      void stderrResult;
      if (timedOut) {
        throw new MailRunnerError('TIMEOUT');
      }
      if (exceededOutput) {
        throw new MailRunnerError('OUTPUT_LIMIT');
      }
      if (exitCode !== 0) {
        throw new MailRunnerError('PROCESS_FAILURE');
      }
      return stdoutResult;
    } catch (error) {
      if (timedOut) {
        throw new MailRunnerError('TIMEOUT');
      }
      if (exceededOutput) {
        throw new MailRunnerError('OUTPUT_LIMIT');
      }
      if (error instanceof MailRunnerError) {
        throw error;
      }
      throw new MailRunnerError('PROCESS_FAILURE');
    } finally {
      clearTimeout(timer);
    }
  }
}
