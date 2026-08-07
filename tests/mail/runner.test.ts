import { describe, expect, test } from 'bun:test';

import { MailAdapterError, MailRunnerError } from '../../src/mail/errors';
import {
  AppleScriptMailRunner,
  type MailProcessSpawner,
} from '../../src/mail/runner';
import { getMailScript } from '../../src/mail/scripts';
import { MAIL_LIMITS, type MailOperation } from '../../src/mail/types';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function expectRunnerError(
  promise: Promise<unknown>,
  code: MailRunnerError['code'],
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected the runner request to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(MailRunnerError);
    expect((error as MailRunnerError).code).toBe(code);
    expect((error as Error).message).not.toContain('private');
  }
}

describe('fixed AppleScript runner', () => {
  test('invokes osascript directly and keeps user input out of script source', async () => {
    const commands: string[][] = [];
    const spawn: MailProcessSpawner = (command) => {
      commands.push([...command]);
      return {
        exited: Promise.resolve(0),
        kill() {},
        stderr: streamFromText(''),
        stdout: streamFromText('[]'),
      };
    };
    const runner = new AppleScriptMailRunner({ spawn });
    const query = '-e "quoted" \\ path\n日本語';

    await expect(
      runner.run({
        arguments: ['account', 'mailbox', query, 'subject', '500', '25'],
        operation: 'searchMail',
      }),
    ).resolves.toBe('[]');

    const command = commands[0]!;
    expect(command.slice(0, 4)).toEqual([
      '/usr/bin/osascript',
      '-l',
      'AppleScript',
      '-e',
    ]);
    expect(command[4]).toContain('on run argv');
    expect(command[4]).not.toContain(query);
    expect(command[5]).toBe('--');
    expect(command.slice(6)).toEqual([
      'account',
      'mailbox',
      query,
      'subject',
      '500',
      '25',
    ]);
  });

  test('all four scripts are fixed, argv-driven, and contain no shell execution', () => {
    const operations: MailOperation[] = [
      'listFolders',
      'searchMail',
      'getMessageMetadata',
      'getMessageBodies',
    ];

    for (const operation of operations) {
      const script = getMailScript(operation);
      expect(script).toContain('on run argv');
      expect(script).not.toContain('do shell script');
      expect(script).not.toMatch(/\b(delete|move|send)\b/i);
    }
    expect(getMailScript('listFolders')).not.toContain('id of mailboxItem');
    expect(getMailScript('searchMail')).toContain('considering case');
    expect(getMailScript('searchMail')).toContain(
      'items 1 thru boundedCount of messages',
    );
  });

  test('all fixed scripts compare downstream account IDs case-sensitively', () => {
    const operations: MailOperation[] = [
      'listFolders',
      'searchMail',
      'getMessageMetadata',
      'getMessageBodies',
    ];

    for (const operation of operations) {
      const script = getMailScript(operation);
      const findAccount = script.slice(
        script.indexOf('on findAccount(accountId)'),
        script.indexOf('end findAccount') + 'end findAccount'.length,
      );
      expect(findAccount).toContain('considering case');
      expect(findAccount).toContain('if currentId is accountId');
      expect(findAccount).toContain('end considering');
      expect(findAccount.match(/currentId is accountId/g)).toHaveLength(1);
    }
  });

  test('stdout limit covers worst-case escaped body output', () => {
    expect(MAIL_LIMITS.stdoutBytes).toBeGreaterThan(
      MAIL_LIMITS.bodyMessages * MAIL_LIMITS.bodyCharacters * 6,
    );
  });

  test('does not spawn a process for an unsupported operation', async () => {
    let spawnCount = 0;
    const runner = new AppleScriptMailRunner({
      spawn: () => {
        spawnCount += 1;
        throw new Error('must not execute');
      },
    });

    try {
      await runner.run({ arguments: [], operation: 'runSource' as never });
      throw new Error('Expected the unsupported operation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MailAdapterError);
      expect((error as MailAdapterError).code).toBe('UNSUPPORTED_OPERATION');
    }
    expect(spawnCount).toBe(0);
  });

  test('does not spawn a process for arguments containing NUL', async () => {
    let spawnCount = 0;
    const runner = new AppleScriptMailRunner({
      spawn: () => {
        spawnCount += 1;
        throw new Error('must not execute');
      },
    });

    try {
      await runner.run({
        arguments: ['\0synthetic'],
        operation: 'listFolders',
      });
      throw new Error('Expected the invalid argument to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MailAdapterError);
      expect((error as MailAdapterError).code).toBe('INVALID_INPUT');
    }
    expect(spawnCount).toBe(0);
  });

  test('sanitizes non-zero process failures', async () => {
    const runner = new AppleScriptMailRunner({
      spawn: () => ({
        exited: Promise.resolve(1),
        kill() {},
        stderr: streamFromText('private mailbox content'),
        stdout: streamFromText('private message content'),
      }),
    });

    await expectRunnerError(
      runner.run({ arguments: ['1'], operation: 'listFolders' }),
      'PROCESS_FAILURE',
    );
  });

  test('kills timed-out processes and returns a sanitized timeout', async () => {
    let killed = false;
    const runner = new AppleScriptMailRunner({
      executionMilliseconds: 5,
      spawn: () => ({
        exited: new Promise(() => {}),
        kill() {
          killed = true;
        },
        stderr: new ReadableStream(),
        stdout: new ReadableStream(),
      }),
    });

    await expectRunnerError(
      runner.run({ arguments: ['1'], operation: 'listFolders' }),
      'TIMEOUT',
    );
    expect(killed).toBe(true);
  });

  test('kills processes whose stdout exceeds the byte limit', async () => {
    let killed = false;
    const runner = new AppleScriptMailRunner({
      stdoutBytes: 4,
      spawn: () => ({
        exited: Promise.resolve(0),
        kill() {
          killed = true;
        },
        stderr: streamFromText(''),
        stdout: streamFromText('12345'),
      }),
    });

    await expectRunnerError(
      runner.run({ arguments: ['1'], operation: 'listFolders' }),
      'OUTPUT_LIMIT',
    );
    expect(killed).toBe(true);
  });
});
