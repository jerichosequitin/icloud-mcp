import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(
  new URL('./fixtures/stdio-server.ts', import.meta.url),
);

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function policyEnvironment(
  clientId = 'configured-stdio',
): Promise<Record<string, string>> {
  const directory = await mkdtemp(join(tmpdir(), 'icloud-stdio-'));
  const policyPath = join(directory, 'policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      clients: [
        {
          allowBodies: true,
          id: 'configured-stdio',
          mailScope: '*',
          tools: [
            'list_folders',
            'search_mail',
            'get_message_metadata',
            'get_message_bodies',
          ],
          transport: 'stdio',
        },
      ],
      version: 1,
    }),
  );
  return {
    ...inheritedEnvironment(),
    ICLOUD_MCP_AUDIT_DIR: join(directory, 'audit'),
    ICLOUD_MCP_CLIENT_ID: clientId,
    ICLOUD_MCP_POLICY_PATH: policyPath,
  };
}

async function verifyStdioEra(mode: 'legacy' | 'modern'): Promise<void> {
  const client = new Client(
    { name: `stdio-${mode}`, version: '1.0.0' },
    mode === 'modern'
      ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } }
      : undefined,
  );
  const transport = new StdioClientTransport({
    args: [fixture],
    command: process.execPath,
    cwd: process.cwd(),
    env: await policyEnvironment(),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  await client.connect(transport);
  try {
    expect(client.getProtocolEra()).toBe(mode);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      'list_folders',
      'search_mail',
      'get_message_metadata',
      'get_message_bodies',
    ]);
  } finally {
    await client.close();
  }
  expect(stderr).toBe('');
}

describe('stdio transport', () => {
  test('serves exactly four tools with protocol-only stdout in both eras', async () => {
    await verifyStdioEra('legacy');
    await verifyStdioEra('modern');
  });

  test('fails startup for missing or unknown configured identity', async () => {
    for (const identity of [undefined, 'unknown-client']) {
      const environment = await policyEnvironment(identity ?? 'temporary');
      if (identity === undefined) {
        delete environment.ICLOUD_MCP_CLIENT_ID;
      }
      const transport = new StdioClientTransport({
        args: [fixture],
        command: process.execPath,
        cwd: process.cwd(),
        env: environment,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client({ name: 'rejected', version: '1.0.0' });
      await expect(client.connect(transport)).rejects.toThrow();
      await transport.close();
      expect(stderr).toBe('Unable to start the local MCP stdio server.\n');
    }
  });
});
