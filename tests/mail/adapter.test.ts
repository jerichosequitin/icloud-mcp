import { describe, expect, test } from 'bun:test';

import { AppleMailAdapter } from '../../src/mail/adapter';
import { MailAdapterError, MailRunnerError } from '../../src/mail/errors';
import {
  createFolderLocator,
  createMessageLocator,
} from '../../src/mail/locators';
import type {
  MailScriptInvocation,
  MailScriptRunner,
} from '../../src/mail/runner';
import { MAIL_LIMITS } from '../../src/mail/types';

class FakeRunner implements MailScriptRunner {
  readonly invocations: MailScriptInvocation[] = [];

  constructor(
    private readonly response:
      string | ((invocation: MailScriptInvocation) => string | Promise<string>),
  ) {}

  async run(invocation: MailScriptInvocation): Promise<string> {
    this.invocations.push(invocation);
    return typeof this.response === 'function'
      ? this.response(invocation)
      : this.response;
  }
}

const folder = createFolderLocator({
  accountId: 'account-1',
  mailboxPath: ['Archive', '2026'],
});
const message = createMessageLocator({
  accountId: 'account-1',
  mailboxPath: ['Archive', '2026'],
  messageId: '42',
});
const missingMessage = createMessageLocator({
  accountId: 'account-1',
  mailboxPath: ['Archive', '2026'],
  messageId: '404',
});

async function expectAdapterError(
  promise: Promise<unknown>,
  code: MailAdapterError['code'],
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected the adapter request to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(MailAdapterError);
    expect((error as MailAdapterError).code).toBe(code);
  }
}

describe('AppleMailAdapter', () => {
  test('lists concise folders with opaque locators', async () => {
    const runner = new FakeRunner(
      JSON.stringify([
        ['account-1', ['Inbox'], 'Inbox', 'iCloud'],
        ['account-1', ['Archive', '2026'], '2026', null],
      ]),
    );
    const adapter = new AppleMailAdapter(runner);

    const result = await adapter.listFolders({ limit: 2 });

    expect(result).toEqual({
      folders: [
        {
          accountName: 'iCloud',
          locator: createFolderLocator({
            accountId: 'account-1',
            mailboxPath: ['Inbox'],
          }),
          name: 'Inbox',
        },
        {
          accountName: null,
          locator: createFolderLocator({
            accountId: 'account-1',
            mailboxPath: ['Archive', '2026'],
          }),
          name: '2026',
        },
      ],
      truncated: true,
    });
    expect(runner.invocations).toEqual([
      { arguments: ['2'], operation: 'listFolders' },
    ]);
  });

  test('passes quotes, backslashes, newlines, and non-ASCII as one search argument', async () => {
    const query = 'subject "quoted" \\ path\nこんにちは';
    const runner = new FakeRunner(
      JSON.stringify([
        [
          [
            'account-1',
            ['Archive', '2026'],
            '42',
            'Synthetic subject',
            null,
            'Friday, 7 August 2026 at 10:00:00',
          ],
        ],
        false,
      ]),
    );
    const adapter = new AppleMailAdapter(runner);

    const result = await adapter.searchMail({
      field: 'subject',
      folder,
      limit: 1,
      query,
    });

    expect(runner.invocations[0]).toEqual({
      operation: 'searchMail',
      arguments: [
        'account-1',
        '["Archive","2026"]',
        query,
        'subject',
        String(MAIL_LIMITS.searchScanMessages),
        '1',
      ],
    });
    expect(result).toEqual({
      messages: [
        {
          locator: message,
          receivedDate: 'Friday, 7 August 2026 at 10:00:00',
          sender: null,
          subject: 'Synthetic subject',
        },
      ],
      truncated: true,
    });
  });

  test('returns metadata separately from bodies and preserves missing locators', async () => {
    const runner = new FakeRunner((invocation) => {
      if (invocation.operation === 'getMessageMetadata') {
        return JSON.stringify([
          [
            true,
            null,
            'sender@example.test',
            ['to@example.test'],
            [],
            [],
            '<synthetic@example.test>',
            null,
            null,
            true,
            false,
          ],
          [false],
        ]);
      }
      return JSON.stringify([
        [true, 'Synthetic body\nwith Unicode: café', true],
        [false],
      ]);
    });
    const adapter = new AppleMailAdapter(runner);

    const metadata = await adapter.getMessageMetadata({
      locators: [message, missingMessage],
    });
    const bodies = await adapter.getMessageBodies({
      locators: [message, missingMessage],
      maxCharacters: 1_000,
    });

    expect(metadata).toEqual({
      messages: [
        {
          bcc: [],
          cc: [],
          flagged: false,
          locator: message,
          messageId: '<synthetic@example.test>',
          read: true,
          receivedDate: null,
          sender: 'sender@example.test',
          sentDate: null,
          subject: null,
          to: ['to@example.test'],
        },
      ],
      missingLocators: [missingMessage],
    });
    expect(bodies).toEqual({
      messages: [
        {
          body: 'Synthetic body\nwith Unicode: café',
          locator: message,
          truncated: true,
        },
      ],
      missingLocators: [missingMessage],
    });
    expect(runner.invocations[0]?.arguments).toEqual([
      'account-1',
      '["Archive","2026"]',
      '42',
      'account-1',
      '["Archive","2026"]',
      '404',
    ]);
    expect(runner.invocations[1]?.arguments).toEqual([
      '1000',
      'account-1',
      '["Archive","2026"]',
      '42',
      'account-1',
      '["Archive","2026"]',
      '404',
    ]);
  });

  test('rejects unsupported operations and fields before invoking the runner', async () => {
    const runner = new FakeRunner('[]');
    const adapter = new AppleMailAdapter(runner);

    await expectAdapterError(
      adapter.execute(
        'deleteMessage' as never,
        {
          script: 'tell application "Mail" to delete every message',
        } as never,
      ),
      'UNSUPPORTED_OPERATION',
    );
    await expectAdapterError(
      adapter.searchMail({
        field: 'body' as never,
        folder,
        query: 'synthetic',
      }),
      'INVALID_INPUT',
    );
    await expectAdapterError(
      adapter.listFolders({ script: 'return private data' } as never),
      'INVALID_INPUT',
    );
    expect(runner.invocations).toHaveLength(0);
  });

  test('enforces locator, query, and result limits before execution', async () => {
    const runner = new FakeRunner('[]');
    const adapter = new AppleMailAdapter(runner);

    await expectAdapterError(
      adapter.searchMail({
        field: 'subject',
        folder: 'not-a-locator' as never,
        query: 'synthetic',
      }),
      'INVALID_INPUT',
    );
    await expectAdapterError(
      adapter.searchMail({
        field: 'subject',
        folder,
        query: 'x'.repeat(MAIL_LIMITS.queryCharacters + 1),
      }),
      'INVALID_INPUT',
    );
    await expectAdapterError(
      adapter.searchMail({
        field: 'subject',
        folder,
        query: '\0synthetic',
      }),
      'INVALID_INPUT',
    );
    await expectAdapterError(
      adapter.getMessageBodies({
        locators: Array.from(
          { length: MAIL_LIMITS.bodyMessages + 1 },
          () => message,
        ),
      }),
      'INVALID_INPUT',
    );
    await expectAdapterError(
      adapter.listFolders({ limit: MAIL_LIMITS.folders + 1 }),
      'INVALID_INPUT',
    );
    expect(() =>
      createMessageLocator({
        accountId: 'account-1',
        mailboxPath: Array.from({ length: 5 }, () => 'x'.repeat(512)),
        messageId: '42',
      }),
    ).toThrow(MailAdapterError);
    expect(runner.invocations).toHaveLength(0);
  });

  test('reports truncation when the bounded mailbox scan is exhausted', async () => {
    const adapter = new AppleMailAdapter(new FakeRunner('[[],true]'));

    await expect(
      adapter.searchMail({
        field: 'subject',
        folder,
        query: 'not found in first 500',
      }),
    ).resolves.toEqual({ messages: [], truncated: true });
  });

  test('sanitizes malformed output and process failures', async () => {
    const malformedAdapter = new AppleMailAdapter(new FakeRunner('[['));
    const shortRowAdapter = new AppleMailAdapter(
      new FakeRunner(JSON.stringify([['account-only']])),
    );
    const failingAdapter = new AppleMailAdapter({
      run: () =>
        Promise.reject(
          new MailRunnerError('PROCESS_FAILURE'),
        ) as Promise<string>,
    });

    await expectAdapterError(
      malformedAdapter.listFolders(),
      'MALFORMED_RESPONSE',
    );
    await expectAdapterError(
      shortRowAdapter.listFolders(),
      'MALFORMED_RESPONSE',
    );
    await expectAdapterError(failingAdapter.listFolders(), 'EXECUTION_FAILED');
  });

  test('rejects parser output above the requested result count', async () => {
    const runner = new FakeRunner(
      JSON.stringify([
        [
          ['account-1', ['Inbox'], 'one', null, null, null],
          ['account-1', ['Inbox'], 'two', null, null, null],
        ],
        false,
      ]),
    );
    const adapter = new AppleMailAdapter(runner);

    await expectAdapterError(
      adapter.searchMail({
        field: 'sender',
        folder,
        limit: 1,
        query: 'example.test',
      }),
      'MALFORMED_RESPONSE',
    );
  });
});
