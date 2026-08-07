import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type {
  AuthenticatedPrincipal,
  ClientAccessPolicy,
  MailToolName,
} from '../../src/access';
import { createMailMcpServer } from '../../src/mcp/server';
import { MAIL_LIMITS } from '../../src/mail/types';
import {
  FakeMailAdapter,
  RecordingAuditLog,
  SYNTHETIC_FOLDER,
  SYNTHETIC_MESSAGE,
  SYNTHETIC_OTHER_FOLDER,
  SYNTHETIC_OTHER_MESSAGE,
} from '../mcp/fakes';
import { parseFolderLocator } from '../../src/mail/locators';

function principal({
  allowBodies = true,
  tools = [
    'list_folders',
    'search_mail',
    'get_message_metadata',
    'get_message_bodies',
  ],
}: {
  allowBodies?: boolean;
  tools?: readonly MailToolName[];
} = {}): AuthenticatedPrincipal {
  const client: ClientAccessPolicy = {
    allowBodies,
    id: 'scoped-client',
    mailScope: [
      {
        address: parseFolderLocator(SYNTHETIC_FOLDER),
        locator: SYNTHETIC_FOLDER,
      },
    ],
    tools: new Set(tools),
    transport: 'stdio',
  };
  return { client, transport: 'stdio' };
}

async function withClient<Result>(
  adapter: FakeMailAdapter,
  audit: RecordingAuditLog,
  access: AuthenticatedPrincipal,
  run: (client: Client) => Promise<Result>,
): Promise<Result> {
  const server = createMailMcpServer({
    adapter,
    audit,
    principal: access,
    protocolEra: 'legacy',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'untrusted-client', version: '9.9.9' });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function expectAccessDenied(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result).toEqual({
    content: [
      {
        text: JSON.stringify({
          error: { code: 'ACCESS_DENIED', message: 'Access denied.' },
        }),
        type: 'text',
      },
    ],
    isError: true,
  });
}

describe('Mail access authorization', () => {
  test('advertises only the configured exact tool subset', async () => {
    const adapter = new FakeMailAdapter();
    const audit = new RecordingAuditLog();
    await withClient(
      adapter,
      audit,
      principal({ tools: ['list_folders', 'search_mail'] }),
      async (client) => {
        expect(
          (await client.listTools()).tools.map(({ name }) => name),
        ).toEqual(['list_folders', 'search_mail']);
        expectAccessDenied(
          await client.callTool({
            arguments: { locators: [SYNTHETIC_MESSAGE] },
            name: 'get_message_metadata',
          }),
        );
      },
    );
    expect(adapter.calls).toHaveLength(0);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        decision: 'deny',
        reason: 'DENY_TOOL',
        tool: 'get_message_metadata',
      }),
    ]);
  });

  test('lists at the adapter maximum, filters scope, then applies the request limit', async () => {
    const adapter = new FakeMailAdapter();
    adapter.folders = {
      folders: [
        {
          accountName: 'Synthetic Account',
          locator: SYNTHETIC_OTHER_FOLDER,
          name: 'Other',
        },
        {
          accountName: 'Synthetic Account',
          locator: SYNTHETIC_FOLDER,
          name: 'Inbox',
        },
      ],
      truncated: false,
    };
    const audit = new RecordingAuditLog();

    await withClient(adapter, audit, principal(), async (client) => {
      const result = await client.callTool({
        arguments: { limit: 1 },
        name: 'list_folders',
      });
      expect(result.structuredContent).toEqual({
        folders: [
          {
            accountName: 'Synthetic Account',
            locator: SYNTHETIC_FOLDER,
            name: 'Inbox',
          },
        ],
        truncated: false,
      });
    });

    expect(adapter.calls).toEqual([
      { input: { limit: MAIL_LIMITS.folders }, operation: 'listFolders' },
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        clientId: 'scoped-client',
        decision: 'allow',
        reason: 'ALLOW_POLICY',
        tool: 'list_folders',
        untrustedMcpClient: {
          name: 'untrusted-client',
          version: '9.9.9',
        },
      }),
    ]);
  });

  test('denies folder and mixed-message access atomically before execution', async () => {
    const calls = [
      {
        arguments: {
          field: 'subject',
          folder: SYNTHETIC_OTHER_FOLDER,
          query: 'private query',
        },
        name: 'search_mail',
      },
      {
        arguments: {
          locators: [SYNTHETIC_MESSAGE, SYNTHETIC_OTHER_MESSAGE],
        },
        name: 'get_message_metadata',
      },
    ];

    for (const call of calls) {
      const adapter = new FakeMailAdapter();
      const audit = new RecordingAuditLog();
      await withClient(adapter, audit, principal(), async (client) => {
        expectAccessDenied(await client.callTool(call));
      });
      expect(adapter.calls).toHaveLength(0);
      expect(audit.entries).toEqual([
        expect.objectContaining({
          decision: 'deny',
          reason: 'DENY_FOLDER',
        }),
      ]);
      expect(JSON.stringify(audit.entries)).not.toContain('private query');
      expect(JSON.stringify(audit.entries)).not.toContain(
        SYNTHETIC_OTHER_MESSAGE,
      );
    }
  });

  test('requires explicit body access in addition to body tool permission', async () => {
    const adapter = new FakeMailAdapter();
    const audit = new RecordingAuditLog();
    await withClient(
      adapter,
      audit,
      principal({ allowBodies: false }),
      async (client) =>
        expectAccessDenied(
          await client.callTool({
            arguments: { locators: [SYNTHETIC_MESSAGE] },
            name: 'get_message_bodies',
          }),
        ),
    );
    expect(adapter.calls).toHaveLength(0);
    expect(audit.entries[0]).toMatchObject({
      decision: 'deny',
      reason: 'DENY_BODY',
    });
  });

  test('fails closed before adapter execution when an allow audit cannot append', async () => {
    const adapter = new FakeMailAdapter();
    const audit = new RecordingAuditLog();
    audit.failure = new Error('synthetic append failure with private details');

    await withClient(adapter, audit, principal(), async (client) => {
      const result = await client.callTool({
        arguments: {
          field: 'subject',
          folder: SYNTHETIC_FOLDER,
          query: 'private query',
        },
        name: 'search_mail',
      });
      expect(result).toEqual({
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
      expect(JSON.stringify(result)).not.toContain('private');
    });
    expect(adapter.calls).toHaveLength(0);
  });
});
