import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAccessPolicy } from '../../src/access';

type ChatGptPolicy = {
  clients: Array<{
    allowBodies: boolean;
    id: string;
    mailScope: { folders: string[] } | '*';
    tools: string[];
    transport: string;
  }>;
  version: number;
};

const documentation = Bun.file(
  new URL('../../docs/connectors/chatgpt-secure-tunnel.md', import.meta.url),
);
const examplePolicy = Bun.file(
  new URL('../../examples/policies/chatgpt-web.example.json', import.meta.url),
);

describe('ChatGPT Web Secure MCP Tunnel connector contract', () => {
  test('pins a synthetic least-privilege stdio policy', async () => {
    const policy = (await examplePolicy.json()) as ChatGptPolicy;

    expect(policy).toEqual({
      clients: [
        {
          allowBodies: false,
          id: 'chatgpt-web',
          mailScope: {
            folders: [
              'icloud-mail-v1.folder.WyJzeW50aGV0aWMtYWNjb3VudCIsWyJJbmJveCJdXQ',
            ],
          },
          tools: ['list_folders', 'search_mail', 'get_message_metadata'],
          transport: 'stdio',
        },
      ],
      version: 1,
    });

    const directory = await mkdtemp(join(tmpdir(), 'icloud-chatgpt-policy-'));
    const policyPath = join(directory, 'policy.json');
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    const loaded = await loadAccessPolicy(policyPath, {
      environment: {},
      transport: 'stdio',
    });

    expect(loaded.clients.get('chatgpt-web')).toMatchObject({
      allowBodies: false,
      id: 'chatgpt-web',
      transport: 'stdio',
    });
    expect([...loaded.clients.get('chatgpt-web')!.tools]).toEqual([
      'list_folders',
      'search_mail',
      'get_message_metadata',
    ]);
    expect(loaded.httpCredentials).toEqual([]);
  });

  test('documents the official outbound-only named stdio profile', async () => {
    const guide = await documentation.text();

    expect(guide).toContain(
      'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
    );
    expect(guide).toContain('--sample sample_mcp_stdio_local');
    expect(guide).toContain('--profile chatgpt-web');
    expect(guide).toContain('--mcp-command');
    expect(guide).toContain('CONTROL_PLANE_API_KEY');
    expect(guide).toContain('ICLOUD_MCP_CLIENT_ID=chatgpt-web');
    expect(guide).toContain('ICLOUD_MCP_POLICY_PATH=/absolute/private/');
    expect(guide).toContain('run mcp:stdio');
    expect(guide).toContain('outbound HTTPS');
    expect(guide).toContain('No inbound route');
    expect(guide).not.toContain('run mcp:http');
  });

  test('keeps credentials, live identifiers, and external operations out of the contract', async () => {
    const [guide, policy] = await Promise.all([
      documentation.text(),
      examplePolicy.text(),
    ]);
    const contract = `${guide}\n${policy}`;

    expect(contract).not.toMatch(/\bsk-[A-Za-z0-9_-]+/);
    expect(contract).not.toMatch(/\btunnel_[A-Za-z0-9]+/);
    expect(contract).not.toMatch(/Authorization:\s*Bearer/i);
    expect(guide).toContain('do not place its value in the policy');
    expect(guide).toContain('not performed by repository tests');
    expect(guide).toContain('remain operational blockers');
  });
});
