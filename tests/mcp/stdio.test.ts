import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(
  new URL('./fixtures/stdio-server.ts', import.meta.url),
);

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
});
