export const MAIL_LIMITS = {
  bodyCharacters: 100_000,
  bodyMessages: 5,
  executionMilliseconds: 15_000,
  folders: 250,
  locatorCharacters: 2_048,
  metadataMessages: 50,
  queryCharacters: 200,
  searchResults: 50,
  searchScanMessages: 500,
  stderrBytes: 16_384,
  stdoutBytes: 1_500_000,
} as const;

declare const folderLocatorBrand: unique symbol;
declare const messageLocatorBrand: unique symbol;

export type MailFolderLocator = string & {
  readonly [folderLocatorBrand]: 'MailFolderLocator';
};

export type MailMessageLocator = string & {
  readonly [messageLocatorBrand]: 'MailMessageLocator';
};

export type MailSearchField = 'recipient' | 'sender' | 'subject';

export interface ListFoldersInput {
  limit?: number;
}

export interface MailFolder {
  accountName: string | null;
  locator: MailFolderLocator;
  name: string | null;
}

export interface ListFoldersResult {
  folders: MailFolder[];
  truncated: boolean;
}

export interface SearchMailInput {
  field: MailSearchField;
  folder: MailFolderLocator;
  limit?: number;
  query: string;
}

export interface MailSearchResult {
  locator: MailMessageLocator;
  receivedDate: string | null;
  sender: string | null;
  subject: string | null;
}

export interface SearchMailResult {
  messages: MailSearchResult[];
  truncated: boolean;
}

export interface GetMessageMetadataInput {
  locators: readonly MailMessageLocator[];
}

export interface MailMessageMetadata {
  bcc: string[];
  cc: string[];
  flagged: boolean | null;
  locator: MailMessageLocator;
  messageId: string | null;
  read: boolean | null;
  receivedDate: string | null;
  sender: string | null;
  sentDate: string | null;
  subject: string | null;
  to: string[];
}

export interface GetMessageMetadataResult {
  messages: MailMessageMetadata[];
  missingLocators: MailMessageLocator[];
}

export interface GetMessageBodiesInput {
  locators: readonly MailMessageLocator[];
  maxCharacters?: number;
}

export interface MailMessageBody {
  body: string | null;
  locator: MailMessageLocator;
  truncated: boolean;
}

export interface GetMessageBodiesResult {
  messages: MailMessageBody[];
  missingLocators: MailMessageLocator[];
}

export interface MailOperationMap {
  getMessageBodies: {
    input: GetMessageBodiesInput;
    output: GetMessageBodiesResult;
  };
  getMessageMetadata: {
    input: GetMessageMetadataInput;
    output: GetMessageMetadataResult;
  };
  listFolders: {
    input: ListFoldersInput;
    output: ListFoldersResult;
  };
  searchMail: {
    input: SearchMailInput;
    output: SearchMailResult;
  };
}

export type MailOperation = keyof MailOperationMap;
export type MailOperationInput<Operation extends MailOperation> =
  MailOperationMap[Operation]['input'];
export type MailOperationOutput<Operation extends MailOperation> =
  MailOperationMap[Operation]['output'];

export type MailOperationRequest = {
  [Operation in MailOperation]: {
    input: MailOperationInput<Operation>;
    operation: Operation;
  };
}[MailOperation];
