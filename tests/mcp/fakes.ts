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

export interface AdapterCall {
  input: unknown;
  operation:
    'getMessageBodies' | 'getMessageMetadata' | 'listFolders' | 'searchMail';
}

export class FakeMailAdapter implements MailMcpAdapter {
  readonly calls: AdapterCall[] = [];
  failure: unknown;

  async listFolders(input: ListFoldersInput = {}): Promise<ListFoldersResult> {
    this.record('listFolders', input);
    return {
      folders: [
        {
          accountName: 'Synthetic Account',
          locator: SYNTHETIC_FOLDER,
          name: 'Inbox',
        },
      ],
      truncated: false,
    };
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
    this.calls.push({ input, operation });
  }
}
