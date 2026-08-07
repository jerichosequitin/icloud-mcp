import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';

import type { AppleMailAdapter } from '../mail/adapter';
import { MailAdapterError, type MailAdapterErrorCode } from '../mail/errors';
import type {
  GetMessageBodiesInput,
  GetMessageMetadataInput,
  ListFoldersInput,
  SearchMailInput,
} from '../mail/types';
import {
  getMessageBodiesInputSchema,
  getMessageBodiesOutputSchema,
  getMessageMetadataInputSchema,
  getMessageMetadataOutputSchema,
  listFoldersInputSchema,
  listFoldersOutputSchema,
  searchMailInputSchema,
  searchMailOutputSchema,
} from './schemas';

export type MailMcpAdapter = Pick<
  AppleMailAdapter,
  'getMessageBodies' | 'getMessageMetadata' | 'listFolders' | 'searchMail'
>;

export const MAIL_TOOL_NAMES = [
  'list_folders',
  'search_mail',
  'get_message_metadata',
  'get_message_bodies',
] as const;

export const MAIL_TOOL_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
};

const ERROR_MESSAGES: Record<MailAdapterErrorCode, string> = {
  EXECUTION_FAILED: 'Apple Mail could not complete the read-only request.',
  EXECUTION_TIMEOUT: 'The read-only Apple Mail request timed out.',
  INVALID_INPUT: 'The Apple Mail request input is invalid.',
  MALFORMED_RESPONSE: 'Apple Mail returned an invalid response.',
  OUTPUT_LIMIT_EXCEEDED:
    'The Apple Mail response exceeded the safe size limit.',
  UNSUPPORTED_OPERATION: 'The requested Apple Mail operation is not supported.',
};

function errorResult(error: unknown) {
  const failure =
    error instanceof MailAdapterError
      ? { code: error.code, message: ERROR_MESSAGES[error.code] }
      : {
          code: 'INTERNAL_ERROR',
          message: 'The mail request could not be completed.',
        };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: failure }) },
    ],
    isError: true as const,
  };
}

async function callAdapter<Result>(operation: () => Promise<Result>): Promise<
  | {
      content: { text: string; type: 'text' }[];
      structuredContent: Result;
    }
  | ReturnType<typeof errorResult>
> {
  try {
    const structuredContent = await operation();
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    return errorResult(error);
  }
}

export function registerMailTools(
  server: McpServer,
  adapter: MailMcpAdapter,
): void {
  server.registerTool(
    'list_folders',
    {
      annotations: MAIL_TOOL_ANNOTATIONS,
      description:
        'List readable Apple Mail folders with opaque locators. Returns no messages or message bodies.',
      inputSchema: listFoldersInputSchema,
      outputSchema: listFoldersOutputSchema,
      title: 'List Mail Folders',
    },
    (input) =>
      callAdapter(() =>
        adapter.listFolders(input as unknown as ListFoldersInput),
      ),
  );

  server.registerTool(
    'search_mail',
    {
      annotations: MAIL_TOOL_ANNOTATIONS,
      description:
        'Search one Apple Mail folder by subject, sender, or recipient. Returns concise metadata only, never message bodies.',
      inputSchema: searchMailInputSchema,
      outputSchema: searchMailOutputSchema,
      title: 'Search Mail',
    },
    (input) =>
      callAdapter(() =>
        adapter.searchMail(input as unknown as SearchMailInput),
      ),
  );

  server.registerTool(
    'get_message_metadata',
    {
      annotations: MAIL_TOOL_ANNOTATIONS,
      description:
        'Get headers and Mail status for selected opaque message locators. Returns no message bodies.',
      inputSchema: getMessageMetadataInputSchema,
      outputSchema: getMessageMetadataOutputSchema,
      title: 'Get Message Metadata',
    },
    (input) =>
      callAdapter(() =>
        adapter.getMessageMetadata(input as unknown as GetMessageMetadataInput),
      ),
  );

  server.registerTool(
    'get_message_bodies',
    {
      annotations: MAIL_TOOL_ANNOTATIONS,
      description:
        'Get body content only for selected opaque message locators, with explicit count and character limits.',
      inputSchema: getMessageBodiesInputSchema,
      outputSchema: getMessageBodiesOutputSchema,
      title: 'Get Message Bodies',
    },
    (input) =>
      callAdapter(() =>
        adapter.getMessageBodies(input as unknown as GetMessageBodiesInput),
      ),
  );
}
