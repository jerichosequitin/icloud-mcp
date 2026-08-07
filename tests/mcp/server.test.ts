import { describe, expect, test } from 'bun:test';
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';

import { MailAdapterError } from '../../src/mail/errors';
import { MAIL_LIMITS } from '../../src/mail/types';
import { createMailMcpServer } from '../../src/mcp/server';
import { MAIL_TOOL_ANNOTATIONS, MAIL_TOOL_NAMES } from '../../src/mcp/tools';
import { FakeMailAdapter, SYNTHETIC_FOLDER, SYNTHETIC_MESSAGE } from './fakes';

async function withClient<Result>(
  adapter: FakeMailAdapter,
  run: (client: Client) => Promise<Result>,
): Promise<Result> {
  const server = createMailMcpServer({ adapter });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-tests', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function expectCompatibleResult(result: CallToolResult): void {
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  if (result.content[0]?.type !== 'text') {
    throw new Error('Expected one compatibility text block.');
  }
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
}

describe('mail MCP tools', () => {
  test('discovers exactly four strictly typed read-only tools', async () => {
    await withClient(new FakeMailAdapter(), async (client) => {
      const { tools } = await client.listTools();

      expect(tools.map(({ name }) => name)).toEqual([...MAIL_TOOL_NAMES]);
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.annotations).toEqual(MAIL_TOOL_ANNOTATIONS);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.type).toBe('object');
        expect(tool.outputSchema?.additionalProperties).toBe(false);
      }
      expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([
        'limit',
      ]);
      expect(Object.keys(tools[1]?.inputSchema.properties ?? {})).toEqual([
        'field',
        'folder',
        'limit',
        'query',
      ]);
      expect(Object.keys(tools[2]?.inputSchema.properties ?? {})).toEqual([
        'locators',
      ]);
      expect(Object.keys(tools[3]?.inputSchema.properties ?? {})).toEqual([
        'locators',
        'maxCharacters',
      ]);
    });
  });

  test('returns all four validated results and preserves adapter arguments', async () => {
    const adapter = new FakeMailAdapter();
    await withClient(adapter, async (client) => {
      const list = await client.callTool({
        arguments: { limit: 10 },
        name: 'list_folders',
      });
      const search = await client.callTool({
        arguments: {
          field: 'subject',
          folder: SYNTHETIC_FOLDER,
          limit: 4,
          query: ' Synthetic query ',
        },
        name: 'search_mail',
      });
      const metadata = await client.callTool({
        arguments: { locators: [SYNTHETIC_MESSAGE] },
        name: 'get_message_metadata',
      });
      const bodies = await client.callTool({
        arguments: {
          locators: [SYNTHETIC_MESSAGE],
          maxCharacters: 1234,
        },
        name: 'get_message_bodies',
      });

      for (const result of [list, search, metadata, bodies]) {
        expectCompatibleResult(result);
      }
      expect(metadata.structuredContent).not.toHaveProperty('body');
      expect(JSON.stringify(metadata.structuredContent)).not.toContain(
        'Synthetic body.',
      );
      expect(bodies.structuredContent).toHaveProperty('messages.0.body');
      expect(adapter.calls).toEqual([
        { input: { limit: 10 }, operation: 'listFolders' },
        {
          input: {
            field: 'subject',
            folder: SYNTHETIC_FOLDER,
            limit: 4,
            query: ' Synthetic query ',
          },
          operation: 'searchMail',
        },
        {
          input: { locators: [SYNTHETIC_MESSAGE] },
          operation: 'getMessageMetadata',
        },
        {
          input: {
            locators: [SYNTHETIC_MESSAGE],
            maxCharacters: 1234,
          },
          operation: 'getMessageBodies',
        },
      ]);
    });
  });

  test('rejects unknown, extra, oversized, and arbitrary inputs before execution', async () => {
    const adapter = new FakeMailAdapter();
    await withClient(adapter, async (client) => {
      await expect(
        client.callTool({ arguments: {}, name: 'delete_message' }),
      ).rejects.toThrow();

      const invalidCalls = [
        {
          arguments: { limit: 1, script: 'return messages' },
          name: 'list_folders',
        },
        { arguments: { code: 'raw code', limit: 1 }, name: 'list_folders' },
        { arguments: { limit: 1, path: '/tmp/script' }, name: 'list_folders' },
        {
          arguments: { limit: 1, predicate: 'every message' },
          name: 'list_folders',
        },
        { arguments: { limit: 1, shell: 'printenv' }, name: 'list_folders' },
        {
          arguments: {
            field: 'subject',
            folder: SYNTHETIC_FOLDER,
            query: 'x'.repeat(MAIL_LIMITS.queryCharacters + 1),
          },
          name: 'search_mail',
        },
        {
          arguments: {
            locators: Array.from(
              { length: MAIL_LIMITS.bodyMessages + 1 },
              () => SYNTHETIC_MESSAGE,
            ),
          },
          name: 'get_message_bodies',
        },
        {
          arguments: { locators: ['not-an-opaque-locator'] },
          name: 'get_message_metadata',
        },
      ];

      for (const call of invalidCalls) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
      }
      expect(adapter.calls).toHaveLength(0);
    });
  });

  test('maps adapter and unknown failures to fixed sanitized errors', async () => {
    const adapter = new FakeMailAdapter();
    await withClient(adapter, async (client) => {
      adapter.failure = new MailAdapterError('EXECUTION_FAILED');
      const adapterFailure = await client.callTool({
        arguments: {},
        name: 'list_folders',
      });
      expect(adapterFailure).toEqual({
        content: [
          {
            text: JSON.stringify({
              error: {
                code: 'EXECUTION_FAILED',
                message: 'Apple Mail could not complete the read-only request.',
              },
            }),
            type: 'text',
          },
        ],
        isError: true,
      });

      adapter.failure = new Error('secret stdout and stack details');
      const unknownFailure = await client.callTool({
        arguments: {},
        name: 'list_folders',
      });
      expect(unknownFailure).toEqual({
        content: [
          {
            text: JSON.stringify({
              error: {
                code: 'INTERNAL_ERROR',
                message: 'The mail request could not be completed.',
              },
            }),
            type: 'text',
          },
        ],
        isError: true,
      });
      expect(JSON.stringify(unknownFailure)).not.toContain('secret');
    });
  });
});
