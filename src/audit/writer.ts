import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  type AuditEntryInput,
} from './schema';

const AUDIT_FILENAME_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const AUDIT_LOCK_RETRY_DELAY_MS = 5;
const AUDIT_LOCK_RETRY_LIMIT = 200;
export const DEFAULT_AUDIT_RETENTION_FILES = 30;

export interface AuditLog {
  append(entry: AuditEntryInput): Promise<void>;
}

export interface LocalAuditLogOptions {
  clock?: () => Date;
  diagnostics?: (message: string) => void;
  directory?: string;
  eventId?: () => string;
  retentionFiles?: number;
}

interface AuditFileHandle {
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
}

async function repairIncompleteAppend(
  handle: AuditFileHandle,
  safeBoundary: number,
  completeBoundary: number,
): Promise<void> {
  const { size } = await handle.stat();
  if (size === safeBoundary || size === completeBoundary) {
    return;
  }
  if (size < safeBoundary || size > completeBoundary) {
    throw new Error('Unable to repair iCloud MCP audit append.');
  }
  await handle.truncate(safeBoundary);
  await handle.sync();
}

export async function appendAuditLine(
  handle: AuditFileHandle,
  line: string,
): Promise<void> {
  const encodedLine = Buffer.from(line, 'utf8');
  const safeBoundary = (await handle.stat()).size;
  let writeComplete = false;
  try {
    const { bytesWritten } = await handle.write(encodedLine);
    writeComplete = bytesWritten === encodedLine.byteLength;
    if (!writeComplete) {
      throw new Error('Incomplete iCloud MCP audit append.');
    }
    await handle.sync();
  } catch (error) {
    if (!writeComplete) {
      try {
        await repairIncompleteAppend(
          handle,
          safeBoundary,
          safeBoundary + encodedLine.byteLength,
        );
      } catch {
        throw new Error('Unable to repair iCloud MCP audit append.');
      }
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return String(error.code);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function withAuditFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < AUDIT_LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      lockHandle = await open(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_WRONLY,
        0o600,
      );
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      await delay(AUDIT_LOCK_RETRY_DELAY_MS);
    }
  }
  if (lockHandle === undefined) {
    throw new Error('Unable to acquire iCloud MCP audit lock.');
  }

  let operationResult: T | undefined;
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  let releaseFailed = false;
  try {
    await lockHandle.close();
  } catch {
    releaseFailed = true;
  }
  try {
    await unlink(lockPath);
  } catch {
    releaseFailed = true;
  }
  if (releaseFailed) {
    throw new Error('Unable to release iCloud MCP audit lock.');
  }
  if (operationFailed) {
    throw operationFailure;
  }
  return operationResult as T;
}

function validRetention(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 366;
}

export function defaultAuditDirectory(): string {
  return join(homedir(), 'Library', 'Logs', 'icloud-mcp');
}

export class LocalAuditLog implements AuditLog {
  readonly #clock: () => Date;
  readonly #diagnostics: (message: string) => void;
  readonly #directory: string;
  readonly #eventId: () => string;
  readonly #retentionFiles: number;
  #lastCleanupDate?: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor({
    clock = () => new Date(),
    diagnostics = (message) => console.error(message),
    directory = defaultAuditDirectory(),
    eventId = randomUUID,
    retentionFiles = DEFAULT_AUDIT_RETENTION_FILES,
  }: LocalAuditLogOptions = {}) {
    if (
      directory.trim().length === 0 ||
      !isAbsolute(directory) ||
      !validRetention(retentionFiles)
    ) {
      throw new Error('Invalid iCloud MCP audit configuration.');
    }
    this.#clock = clock;
    this.#diagnostics = diagnostics;
    this.#directory = resolve(directory);
    this.#eventId = eventId;
    this.#retentionFiles = retentionFiles;
  }

  append(input: AuditEntryInput): Promise<void> {
    const operation = this.#writeQueue.then(
      () => this.#append(input),
      () => this.#append(input),
    );
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #append(input: AuditEntryInput): Promise<void> {
    const now = this.#clock();
    const timestamp = now.toISOString();
    const date = timestamp.slice(0, 10);
    const activeFilename = `audit-${date}.jsonl`;
    const entry: AuditEntry = {
      ...input,
      eventId: this.#eventId(),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      timestamp,
    };
    const line = `${JSON.stringify(entry)}\n`;

    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    if (!(await lstat(this.#directory)).isDirectory()) {
      throw new Error('Invalid iCloud MCP audit directory.');
    }
    await chmod(this.#directory, 0o700);
    await withAuditFileLock(
      join(this.#directory, `.${activeFilename}.lock`),
      async () => {
        const handle = await open(
          join(this.#directory, activeFilename),
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_WRONLY,
          0o600,
        );
        try {
          if (!(await handle.stat()).isFile()) {
            throw new Error('Invalid iCloud MCP audit file.');
          }
          await handle.chmod(0o600);
          await appendAuditLine(handle, line);
        } finally {
          await handle.close();
        }
      },
    );

    if (this.#lastCleanupDate !== date) {
      try {
        await this.cleanup(activeFilename);
        this.#lastCleanupDate = date;
      } catch {
        this.#diagnostics('iCloud MCP audit retention cleanup failed.');
      }
    }
  }

  protected async cleanup(activeFilename: string): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const auditFiles = entries
      .filter(
        (entry) => entry.isFile() && AUDIT_FILENAME_PATTERN.test(entry.name),
      )
      .map(({ name }) => name)
      .sort()
      .reverse();
    const inactiveFiles = auditFiles.filter(
      (filename) => filename !== activeFilename,
    );
    for (const filename of inactiveFiles.slice(this.#retentionFiles - 1)) {
      await unlink(join(this.#directory, filename));
    }
  }
}
