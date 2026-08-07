import {
  createFolderLocator,
  createMessageLocator,
} from '../../src/mail/locators';
import type {
  GetMessageBodiesInput,
  GetMessageBodiesResult,
  GetMessageMetadataInput,
  GetMessageMetadataResult,
  ListFoldersInput,
  ListFoldersResult,
  SearchMailInput,
  SearchMailResult,
} from '../../src/mail/types';
import type { MailMcpAdapter } from '../../src/mcp/tools';

export const SYNTHETIC_FOLDER = createFolderLocator({
  accountId: 'synthetic-account',
  mailboxPath: ['Inbox'],
});

export const SYNTHETIC_MESSAGE = createMessageLocator({
  accountId: 'synthetic-account',
  mailboxPath: ['Inbox'],
  messageId: 'synthetic-message',
});

export const SYNTHETIC_OTHER_FOLDER = createFolderLocator({
  accountId: 'synthetic-account',
  mailboxPath: ['Other'],
});

export const SYNTHETIC_OTHER_MESSAGE = createMessageLocator({
  accountId: 'synthetic-account',
  mailboxPath: ['Other'],
  messageId: 'other-message',
});

export const TEST_HTTP_TOKEN = 'synthetic-http-token';

function testClient(
  id: string,
  transport: 'http' | 'stdio',
  tools: readonly MailToolName[] = [
    'list_folders',
    'search_mail',
    'get_message_metadata',
    'get_message_bodies',
  ],
): ClientAccessPolicy {
  return {
    allowBodies: true,
    id,
    mailScope: '*',
    tools: new Set(tools),
    transport,
    ...(transport === 'http' ? { bearerTokenEnv: 'TEST_HTTP_TOKEN' } : {}),
  };
}

export const TEST_STDIO_CLIENT = testClient('test-stdio', 'stdio');
export const TEST_HTTP_CLIENT = testClient('test-http', 'http');

export const TEST_POLICY: LoadedAccessPolicy = {
  clients: new Map([
    [TEST_STDIO_CLIENT.id, TEST_STDIO_CLIENT],
    [TEST_HTTP_CLIENT.id, TEST_HTTP_CLIENT],
  ]),
  httpCredentials: [
    {
      clientId: TEST_HTTP_CLIENT.id,
      tokenDigest: createHash('sha256')
        .update(TEST_HTTP_TOKEN, 'utf8')
        .digest(),
    },
  ],
  version: 1,
};

export function testPrincipal(
  transport: 'http' | 'stdio' = 'stdio',
): AuthenticatedPrincipal {
  const client = transport === 'http' ? TEST_HTTP_CLIENT : TEST_STDIO_CLIENT;
  return { client, transport };
}

export class RecordingAuditLog implements AuditLog {
  activeRecords = 0;
  readonly entries: AuditEntryInput[] = [];
  failure: unknown;

  async append(entry: AuditEntryInput): Promise<void> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.entries.push(entry);
  }

  async runWithActiveRecord<Result>(
    entry: AuditEntryInput,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.append(entry);
    this.activeRecords += 1;
    try {
      return await operation();
    } finally {
      this.activeRecords -= 1;
    }
  }
}

export interface AdapterCall {
  input: unknown;
  operation:
    'getMessageBodies' | 'getMessageMetadata' | 'listFolders' | 'searchMail';
}

export class FakeMailAdapter implements MailMcpAdapter {
  beforeCall?: () => void;
  readonly calls: AdapterCall[] = [];
  failure: unknown;
  folders: ListFoldersResult = {
    folders: [
      {
        accountName: 'Synthetic Account',
        locator: SYNTHETIC_FOLDER,
        name: 'Inbox',
      },
    ],
    truncated: false,
  };

  async listFolders(input: ListFoldersInput = {}): Promise<ListFoldersResult> {
    this.record('listFolders', input);
    return this.folders;
  }

  async searchMail(input: SearchMailInput): Promise<SearchMailResult> {
    this.record('searchMail', input);
    return {
      messages: [
        {
          locator: SYNTHETIC_MESSAGE,
          receivedDate: 'Friday, 7 August 2026 at 10:00:00',
          sender: 'sender@example.test',
          subject: 'Synthetic subject',
        },
      ],
      truncated: false,
    };
  }

  async getMessageMetadata(
    input: GetMessageMetadataInput,
  ): Promise<GetMessageMetadataResult> {
    this.record('getMessageMetadata', input);
    return {
      messages: [
        {
          bcc: [],
          cc: [],
          flagged: false,
          locator: SYNTHETIC_MESSAGE,
          messageId: '<synthetic@example.test>',
          read: true,
          receivedDate: 'Friday, 7 August 2026 at 10:00:00',
          sender: 'sender@example.test',
          sentDate: 'Friday, 7 August 2026 at 09:59:00',
          subject: 'Synthetic subject',
          to: ['recipient@example.test'],
        },
      ],
      missingLocators: [],
    };
  }

  async getMessageBodies(
    input: GetMessageBodiesInput,
  ): Promise<GetMessageBodiesResult> {
    this.record('getMessageBodies', input);
    return {
      messages: [
        {
          body: 'Synthetic body.',
          locator: SYNTHETIC_MESSAGE,
          truncated: false,
        },
      ],
      missingLocators: [],
    };
  }

  private record(operation: AdapterCall['operation'], input: unknown): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.beforeCall?.();
    this.calls.push({ input, operation });
  }
}
import { createHash } from 'node:crypto';

import type {
  AuthenticatedPrincipal,
  ClientAccessPolicy,
  LoadedAccessPolicy,
  MailToolName,
} from '../../src/access';
import type { AuditEntryInput, AuditLog } from '../../src/audit';
