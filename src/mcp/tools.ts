import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type Server,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  allowsFolder,
  allowsTool,
  MAIL_TOOL_NAMES,
  type AuthenticatedPrincipal,
  type MailToolName,
  type ProtocolEra,
} from '../access';
import type {
  AuditEntryInput,
  AuditLog,
  AuditReasonCode,
  UntrustedMcpClient,
} from '../audit';
import type { AppleMailAdapter } from '../mail/adapter';
import { MailAdapterError, type MailAdapterErrorCode } from '../mail/errors';
import { parseFolderLocator, parseMessageLocator } from '../mail/locators';
import {
  MAIL_LIMITS,
  type GetMessageBodiesInput,
  type GetMessageMetadataInput,
  type ListFoldersInput,
  type ListFoldersResult,
  type SearchMailInput,
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

export { MAIL_TOOL_NAMES };

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

interface RegisterMailToolsOptions {
  adapter: MailMcpAdapter;
  audit: AuditLog;
  principal: AuthenticatedPrincipal;
  protocolEra: ProtocolEra;
}

interface ToolDefinition extends Tool {
  outputSchema: Record<string, unknown>;
}

function inputJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
  return z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'];
}

const TOOL_DEFINITIONS: Record<MailToolName, ToolDefinition> = {
  list_folders: {
    annotations: MAIL_TOOL_ANNOTATIONS,
    description:
      'List readable Apple Mail folders with opaque locators. Returns no messages or message bodies.',
    inputSchema: inputJsonSchema(listFoldersInputSchema),
    name: 'list_folders',
    outputSchema: z.toJSONSchema(listFoldersOutputSchema, { io: 'output' }),
    title: 'List Mail Folders',
  },
  search_mail: {
    annotations: MAIL_TOOL_ANNOTATIONS,
    description:
      'Search one Apple Mail folder by subject, sender, or recipient. Returns concise metadata only, never message bodies.',
    inputSchema: inputJsonSchema(searchMailInputSchema),
    name: 'search_mail',
    outputSchema: z.toJSONSchema(searchMailOutputSchema, { io: 'output' }),
    title: 'Search Mail',
  },
  get_message_metadata: {
    annotations: MAIL_TOOL_ANNOTATIONS,
    description:
      'Get headers and Mail status for selected opaque message locators. Returns no message bodies.',
    inputSchema: inputJsonSchema(getMessageMetadataInputSchema),
    name: 'get_message_metadata',
    outputSchema: z.toJSONSchema(getMessageMetadataOutputSchema, {
      io: 'output',
    }),
    title: 'Get Message Metadata',
  },
  get_message_bodies: {
    annotations: MAIL_TOOL_ANNOTATIONS,
    description:
      'Get body content only for selected opaque message locators, with explicit count and character limits.',
    inputSchema: inputJsonSchema(getMessageBodiesInputSchema),
    name: 'get_message_bodies',
    outputSchema: z.toJSONSchema(getMessageBodiesOutputSchema, {
      io: 'output',
    }),
    title: 'Get Message Bodies',
  },
};

function fixedError(code: string, message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
    isError: true,
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof MailAdapterError) {
    return fixedError(error.code, ERROR_MESSAGES[error.code]);
  }
  return fixedError(
    'INTERNAL_ERROR',
    'The mail request could not be completed.',
  );
}

function untrustedClient(server: Server): UntrustedMcpClient | undefined {
  const reported = server.getClientVersion();
  if (reported === undefined) {
    return undefined;
  }
  return {
    name: reported.name.slice(0, 200),
    version: reported.version.slice(0, 200),
  };
}

function auditInput(
  server: Server,
  options: RegisterMailToolsOptions,
  tool: MailToolName,
  decision: 'allow' | 'deny',
  reason: AuditReasonCode,
): AuditEntryInput {
  const reportedClient = untrustedClient(server);
  return {
    clientId: options.principal.client.id,
    decision,
    protocolEra: options.protocolEra,
    reason,
    tool,
    transport: options.principal.transport,
    ...(reportedClient === undefined
      ? {}
      : { untrustedMcpClient: reportedClient }),
  };
}

async function deny(
  server: Server,
  options: RegisterMailToolsOptions,
  tool: MailToolName,
  reason: AuditReasonCode,
): Promise<CallToolResult> {
  try {
    await options.audit.append(
      auditInput(server, options, tool, 'deny', reason),
    );
  } catch {
    // Access remains denied even when the denial record cannot be appended.
  }
  return fixedError('ACCESS_DENIED', 'Access denied.');
}

async function callAdapter<Result>(
  server: Server,
  options: RegisterMailToolsOptions,
  tool: MailToolName,
  outputSchema: z.ZodType,
  operation: () => Promise<Result>,
): Promise<CallToolResult> {
  try {
    await options.audit.append(
      auditInput(server, options, tool, 'allow', 'ALLOW_POLICY'),
    );
    const parsed = outputSchema.safeParse(await operation());
    if (!parsed.success) {
      throw new MailAdapterError('MALFORMED_RESPONSE');
    }
    const result: CallToolResult = {
      content: [{ type: 'text', text: JSON.stringify(parsed.data) }],
      structuredContent: parsed.data as Record<string, unknown>,
    };
    return server.projectCallToolResult(
      result,
      TOOL_DEFINITIONS[tool].outputSchema,
    );
  } catch (error) {
    return errorResult(error);
  }
}

function scopedFolders(
  result: ListFoldersResult,
  input: ListFoldersInput,
  principal: AuthenticatedPrincipal,
): ListFoldersResult {
  const allowed = result.folders.filter((folder) =>
    allowsFolder(principal.client, parseFolderLocator(folder.locator)),
  );
  const limit = input.limit ?? MAIL_LIMITS.folders;
  return {
    folders: allowed.slice(0, limit),
    truncated:
      allowed.length > limit ||
      (principal.client.mailScope === '*' && result.truncated),
  };
}

function isMailToolName(name: string): name is MailToolName {
  return (MAIL_TOOL_NAMES as readonly string[]).includes(name);
}

function invalidInput(): CallToolResult {
  return fixedError('INVALID_INPUT', ERROR_MESSAGES.INVALID_INPUT);
}

async function callListFolders(
  server: Server,
  options: RegisterMailToolsOptions,
  rawInput: unknown,
): Promise<CallToolResult> {
  const input = listFoldersInputSchema.safeParse(rawInput);
  if (!input.success) {
    return invalidInput();
  }
  return callAdapter(
    server,
    options,
    'list_folders',
    listFoldersOutputSchema,
    async () =>
      scopedFolders(
        await options.adapter.listFolders({ limit: MAIL_LIMITS.folders }),
        input.data as unknown as ListFoldersInput,
        options.principal,
      ),
  );
}

async function callSearchMail(
  server: Server,
  options: RegisterMailToolsOptions,
  rawInput: unknown,
): Promise<CallToolResult> {
  const input = searchMailInputSchema.safeParse(rawInput);
  if (!input.success) {
    return invalidInput();
  }
  if (
    !allowsFolder(
      options.principal.client,
      parseFolderLocator(input.data.folder),
    )
  ) {
    return deny(server, options, 'search_mail', 'DENY_FOLDER');
  }
  return callAdapter(
    server,
    options,
    'search_mail',
    searchMailOutputSchema,
    () => options.adapter.searchMail(input.data as SearchMailInput),
  );
}

async function callMessageMetadata(
  server: Server,
  options: RegisterMailToolsOptions,
  rawInput: unknown,
): Promise<CallToolResult> {
  const input = getMessageMetadataInputSchema.safeParse(rawInput);
  if (!input.success) {
    return invalidInput();
  }
  if (
    !input.data.locators.every((locator) =>
      allowsFolder(options.principal.client, parseMessageLocator(locator)),
    )
  ) {
    return deny(server, options, 'get_message_metadata', 'DENY_FOLDER');
  }
  return callAdapter(
    server,
    options,
    'get_message_metadata',
    getMessageMetadataOutputSchema,
    () =>
      options.adapter.getMessageMetadata(
        input.data as unknown as GetMessageMetadataInput,
      ),
  );
}

async function callMessageBodies(
  server: Server,
  options: RegisterMailToolsOptions,
  rawInput: unknown,
): Promise<CallToolResult> {
  const input = getMessageBodiesInputSchema.safeParse(rawInput);
  if (!input.success) {
    return invalidInput();
  }
  if (!options.principal.client.allowBodies) {
    return deny(server, options, 'get_message_bodies', 'DENY_BODY');
  }
  if (
    !input.data.locators.every((locator) =>
      allowsFolder(options.principal.client, parseMessageLocator(locator)),
    )
  ) {
    return deny(server, options, 'get_message_bodies', 'DENY_FOLDER');
  }
  return callAdapter(
    server,
    options,
    'get_message_bodies',
    getMessageBodiesOutputSchema,
    () =>
      options.adapter.getMessageBodies(
        input.data as unknown as GetMessageBodiesInput,
      ),
  );
}

async function dispatchTool(
  server: Server,
  options: RegisterMailToolsOptions,
  tool: MailToolName,
  input: unknown,
): Promise<CallToolResult> {
  if (!allowsTool(options.principal.client, tool)) {
    return deny(server, options, tool, 'DENY_TOOL');
  }
  switch (tool) {
    case 'list_folders':
      return callListFolders(server, options, input);
    case 'search_mail':
      return callSearchMail(server, options, input);
    case 'get_message_metadata':
      return callMessageMetadata(server, options, input);
    case 'get_message_bodies':
      return callMessageBodies(server, options, input);
  }
}

export function registerMailTools(
  server: Server,
  options: RegisterMailToolsOptions,
): void {
  server.setRequestHandler('tools/list', () => ({
    tools: MAIL_TOOL_NAMES.filter((tool) =>
      allowsTool(options.principal.client, tool),
    ).map((tool) => TOOL_DEFINITIONS[tool]),
  }));
  server.setRequestHandler('tools/call', (request) => {
    const tool = request.params.name;
    if (!isMailToolName(tool)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Unknown Mail tool.',
      );
    }
    return dispatchTool(server, options, tool, request.params.arguments ?? {});
  });
}
