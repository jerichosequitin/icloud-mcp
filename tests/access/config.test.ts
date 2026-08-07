import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadAccessPolicy } from '../../src/access';
import { createFolderLocator } from '../../src/mail/locators';

const folder = createFolderLocator({
  accountId: 'account-id',
  mailboxPath: ['Inbox', 'Receipts'],
});

async function writePolicy(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'icloud-policy-'));
  const path = join(directory, 'policy.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

interface TestClientPolicy {
  allowBodies: boolean;
  bearerTokenEnv?: string;
  id: string;
  mailScope: '*' | { folders: string[] };
  tools: string[];
  transport: string;
  [key: string]: unknown;
}

interface TestPolicy {
  clients: TestClientPolicy[];
  version: number;
  [key: string]: unknown;
}

function validPolicy(): TestPolicy {
  return {
    clients: [
      {
        allowBodies: false,
        id: 'local-client',
        mailScope: { folders: [folder] },
        tools: ['list_folders', 'search_mail'],
        transport: 'stdio',
      },
      {
        allowBodies: true,
        bearerTokenEnv: 'REMOTE_TOKEN',
        id: 'remote-client',
        mailScope: '*',
        tools: [
          'list_folders',
          'search_mail',
          'get_message_metadata',
          'get_message_bodies',
        ],
        transport: 'http',
      },
    ],
    version: 1,
  };
}

describe('access policy configuration', () => {
  test('loads an explicit strict policy and resolves only token environment names', async () => {
    const path = await writePolicy(validPolicy());
    const loaded = await loadAccessPolicy(path, {
      environment: { REMOTE_TOKEN: 'secret-from-launch-environment' },
      transport: 'http',
    });

    expect(loaded.clients.get('local-client')?.mailScope).toEqual([
      {
        address: {
          accountId: 'account-id',
          mailboxPath: ['Inbox', 'Receipts'],
        },
        locator: folder,
      },
    ]);
    expect(loaded.clients.get('remote-client')?.bearerTokenEnv).toBe(
      'REMOTE_TOKEN',
    );
    expect(JSON.stringify(loaded)).not.toContain(
      'secret-from-launch-environment',
    );
  });

  test('fails closed for missing, relative, or repository-local paths', async () => {
    await expect(
      loadAccessPolicy(undefined, { transport: 'stdio' }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');
    await expect(
      loadAccessPolicy('policy.json', { transport: 'stdio' }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');
    await expect(
      loadAccessPolicy(join(process.cwd(), 'policy.example.json'), {
        transport: 'stdio',
      }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');
  });

  test('rejects unknown keys, IDs, tools, locators, secrets, and transport mismatches', async () => {
    const mutations: ((policy: ReturnType<typeof validPolicy>) => void)[] = [
      (policy) => Object.assign(policy, { unexpected: true }),
      (policy) => policy.clients.push({ ...policy.clients[0]! }),
      (policy) => policy.clients[0]!.tools.push('delete_message'),
      (policy) =>
        (policy.clients[0]!.mailScope = { folders: ['invalid-locator'] }),
      (policy) => policy.clients[0]!.tools.push('list_folders'),
      (policy) =>
        Object.assign(policy.clients[0]!, { bearerTokenEnv: 'EXTRA_TOKEN' }),
      (policy) => delete policy.clients[1]!.bearerTokenEnv,
    ];

    for (const mutate of mutations) {
      const policy = validPolicy();
      mutate(policy);
      const path = await writePolicy(policy);
      await expect(
        loadAccessPolicy(path, {
          environment: {
            EXTRA_TOKEN: 'extra-token',
            REMOTE_TOKEN: 'remote-token',
          },
          transport: 'http',
        }),
      ).rejects.toThrow('Invalid iCloud MCP access policy.');
    }

    const missingSecretPath = await writePolicy(validPolicy());
    await expect(
      loadAccessPolicy(missingSecretPath, {
        environment: {},
        transport: 'http',
      }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');
  });

  test('does not resolve unused HTTP secrets for stdio startup', async () => {
    const path = await writePolicy(validPolicy());
    const loaded = await loadAccessPolicy(path, {
      environment: {},
      transport: 'stdio',
    });
    expect(loaded.clients.has('local-client')).toBe(true);
    expect(loaded.httpCredentials).toEqual([]);
  });

  test('rejects policy files or parent directories writable by other users', async () => {
    const groupWritableFile = await writePolicy(validPolicy());
    await chmod(groupWritableFile, 0o660);
    await expect(
      loadAccessPolicy(groupWritableFile, {
        environment: { REMOTE_TOKEN: 'remote-token' },
        transport: 'http',
      }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');

    const unsafeParent = await writePolicy(validPolicy());
    await chmod(dirname(unsafeParent), 0o770);
    await expect(
      loadAccessPolicy(unsafeParent, {
        environment: { REMOTE_TOKEN: 'remote-token' },
        transport: 'http',
      }),
    ).rejects.toThrow('Invalid iCloud MCP access policy.');
  });
});
