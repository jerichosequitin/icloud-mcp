import { MailAdapterError, MailRunnerError } from './errors';
import {
  createFolderLocator,
  createMessageLocator,
  parseFolderLocator,
  parseMessageLocator,
} from './locators';
import {
  parseBodyRows,
  parseFolderRows,
  parseMetadataRows,
  parseSearchResponse,
} from './parser';
import {
  AppleScriptMailRunner,
  type MailScriptInvocation,
  type MailScriptRunner,
} from './runner';
import {
  MAIL_LIMITS,
  type GetMessageBodiesInput,
  type GetMessageBodiesResult,
  type GetMessageMetadataInput,
  type GetMessageMetadataResult,
  type ListFoldersInput,
  type ListFoldersResult,
  type MailMessageLocator,
  type MailOperation,
  type MailOperationInput,
  type MailOperationOutput,
  type SearchMailInput,
  type SearchMailResult,
} from './types';

function integerWithin(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return value;
}

function inputRecord(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !Object.keys(input).every((key) => allowedKeys.includes(key))
  ) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return input as Record<string, unknown>;
}

function optionalLimit(
  value: unknown,
  defaultValue: number,
  maximum: number,
): number {
  return value === undefined ? defaultValue : integerWithin(value, 1, maximum);
}

function validateLocators(
  input: unknown,
  maximum: number,
): readonly MailMessageLocator[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > maximum) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  for (const locator of input) {
    parseMessageLocator(locator);
  }
  return input as readonly MailMessageLocator[];
}

function flattenMessageAddresses(
  locators: readonly MailMessageLocator[],
): string[] {
  return locators.flatMap((locator) => {
    const address = parseMessageLocator(locator);
    return [
      address.accountId,
      JSON.stringify(address.mailboxPath),
      address.messageId,
    ];
  });
}

function runnerError(error: unknown): MailAdapterError {
  if (error instanceof MailAdapterError) {
    return error;
  }
  if (error instanceof MailRunnerError) {
    if (error.code === 'TIMEOUT') {
      return new MailAdapterError('EXECUTION_TIMEOUT');
    }
    if (error.code === 'OUTPUT_LIMIT') {
      return new MailAdapterError('OUTPUT_LIMIT_EXCEEDED');
    }
  }
  return new MailAdapterError('EXECUTION_FAILED');
}

export class AppleMailAdapter {
  readonly #runner: MailScriptRunner;

  constructor(runner: MailScriptRunner = new AppleScriptMailRunner()) {
    this.#runner = runner;
  }

  async execute<Operation extends MailOperation>(
    operation: Operation,
    input: MailOperationInput<Operation>,
  ): Promise<MailOperationOutput<Operation>> {
    switch (operation) {
      case 'getMessageBodies':
        return (await this.getMessageBodies(
          input as GetMessageBodiesInput,
        )) as MailOperationOutput<Operation>;
      case 'getMessageMetadata':
        return (await this.getMessageMetadata(
          input as GetMessageMetadataInput,
        )) as MailOperationOutput<Operation>;
      case 'listFolders':
        return (await this.listFolders(
          input as ListFoldersInput,
        )) as MailOperationOutput<Operation>;
      case 'searchMail':
        return (await this.searchMail(
          input as SearchMailInput,
        )) as MailOperationOutput<Operation>;
      default:
        throw new MailAdapterError('UNSUPPORTED_OPERATION');
    }
  }

  async listFolders(input: ListFoldersInput = {}): Promise<ListFoldersResult> {
    const values = inputRecord(input, ['limit']);
    const limit = optionalLimit(values.limit, 100, MAIL_LIMITS.folders);
    const rows = await this.#run(
      { operation: 'listFolders', arguments: [String(limit)] },
      (output) => parseFolderRows(output, limit),
    );
    return {
      folders: rows.map((row) => ({
        locator: createFolderLocator(row),
        name: row.name,
        accountName: row.accountName,
      })),
      truncated: rows.length === limit,
    };
  }

  async searchMail(input: SearchMailInput): Promise<SearchMailResult> {
    const values = inputRecord(input, ['field', 'folder', 'limit', 'query']);
    if (
      typeof values.query !== 'string' ||
      values.query.trim().length === 0 ||
      values.query.length > MAIL_LIMITS.queryCharacters ||
      typeof values.field !== 'string' ||
      !['recipient', 'sender', 'subject'].includes(values.field)
    ) {
      throw new MailAdapterError('INVALID_INPUT');
    }
    const folder = parseFolderLocator(values.folder);
    const limit = optionalLimit(values.limit, 25, MAIL_LIMITS.searchResults);
    const response = await this.#run(
      {
        operation: 'searchMail',
        arguments: [
          folder.accountId,
          JSON.stringify(folder.mailboxPath),
          values.query,
          values.field,
          String(MAIL_LIMITS.searchScanMessages),
          String(limit),
        ],
      },
      (output) => parseSearchResponse(output, limit),
    );
    return {
      messages: response.rows.map((row) => ({
        locator: createMessageLocator(row),
        subject: row.subject,
        sender: row.sender,
        receivedDate: row.receivedDate,
      })),
      truncated: response.rows.length === limit || response.scanTruncated,
    };
  }

  async getMessageMetadata(
    input: GetMessageMetadataInput,
  ): Promise<GetMessageMetadataResult> {
    const values = inputRecord(input, ['locators']);
    const locators = validateLocators(
      values.locators,
      MAIL_LIMITS.metadataMessages,
    );
    const rows = await this.#run(
      {
        operation: 'getMessageMetadata',
        arguments: flattenMessageAddresses(locators),
      },
      (output) => parseMetadataRows(output, locators.length),
    );
    const messages: GetMessageMetadataResult['messages'] = [];
    const missingLocators: MailMessageLocator[] = [];
    rows.forEach((row, index) => {
      const locator = locators[index]!;
      if (row === null) {
        missingLocators.push(locator);
        return;
      }
      messages.push({
        locator,
        subject: row.subject,
        sender: row.sender,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        messageId: row.messageId,
        receivedDate: row.receivedDate,
        sentDate: row.sentDate,
        read: row.read,
        flagged: row.flagged,
      });
    });
    return { messages, missingLocators };
  }

  async getMessageBodies(
    input: GetMessageBodiesInput,
  ): Promise<GetMessageBodiesResult> {
    const values = inputRecord(input, ['locators', 'maxCharacters']);
    const locators = validateLocators(
      values.locators,
      MAIL_LIMITS.bodyMessages,
    );
    const characterLimit = optionalLimit(
      values.maxCharacters,
      50_000,
      MAIL_LIMITS.bodyCharacters,
    );
    const rows = await this.#run(
      {
        operation: 'getMessageBodies',
        arguments: [
          String(characterLimit),
          ...flattenMessageAddresses(locators),
        ],
      },
      (output) => parseBodyRows(output, locators.length),
    );
    const messages: GetMessageBodiesResult['messages'] = [];
    const missingLocators: MailMessageLocator[] = [];
    rows.forEach((row, index) => {
      const locator = locators[index]!;
      if (row === null) {
        missingLocators.push(locator);
        return;
      }
      messages.push({
        locator,
        body: row.body,
        truncated: row.truncated,
      });
    });
    return { messages, missingLocators };
  }

  async #run<Result>(
    invocation: MailScriptInvocation,
    parse: (output: string) => Result,
  ): Promise<Result> {
    try {
      return parse(await this.#runner.run(invocation));
    } catch (error) {
      throw runnerError(error);
    }
  }
}
