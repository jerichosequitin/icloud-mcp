import { describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalAuditLog } from '../../src/audit';
import { appendAuditLine } from '../../src/audit/writer';

function entry() {
  return {
    clientId: 'synthetic-client',
    decision: 'allow' as const,
    protocolEra: 'modern' as const,
    reason: 'ALLOW_POLICY' as const,
    tool: 'search_mail' as const,
    transport: 'http' as const,
  };
}

describe('local audit log', () => {
  test('writes redacted JSON Lines with secure modes and serialized appends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    await chmod(directory, 0o777);
    let event = 0;
    const audit = new LocalAuditLog({
      clock: () => new Date('2026-08-07T23:59:59.000Z'),
      directory,
      eventId: () => `event-${++event}`,
    });

    await Promise.all(Array.from({ length: 25 }, () => audit.append(entry())));

    const path = join(directory, 'audit-2026-08-07.jsonl');
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(25);
    expect(lines.map((line) => JSON.parse(line).eventId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `event-${index + 1}`),
    );
    expect(await stat(directory).then(({ mode }) => mode & 0o777)).toBe(0o700);
    expect(await stat(path).then(({ mode }) => mode & 0o777)).toBe(0o600);
    const serialized = lines.join('');
    for (const forbidden of [
      'authorization',
      'token',
      'query',
      'locator',
      'subject',
      'body',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  test('rolls over by UTC date and deletes only old exact audit filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      await writeFile(join(directory, `audit-${date}.jsonl`), '{}\n');
    }
    await writeFile(join(directory, 'audit-2026-01-01.jsonl.backup'), 'keep');
    await writeFile(join(directory, 'other.log'), 'keep');

    let now = new Date('2026-08-04T23:59:59.000Z');
    const audit = new LocalAuditLog({
      clock: () => now,
      directory,
      retentionFiles: 3,
    });
    await audit.append(entry());
    now = new Date('2026-08-05T00:00:00.000Z');
    await audit.append(entry());

    expect((await readdir(directory)).sort()).toEqual([
      'audit-2026-01-01.jsonl.backup',
      'audit-2026-08-03.jsonl',
      'audit-2026-08-04.jsonl',
      'audit-2026-08-05.jsonl',
      'other.log',
    ]);
  });

  test('emits only a fixed diagnostic when retention cleanup fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const directory = join(parent, 'audit');
    await mkdir(directory);
    const diagnostics: string[] = [];
    class FailingCleanupAuditLog extends LocalAuditLog {
      protected override async cleanup(): Promise<void> {
        throw new Error(`private cleanup detail: ${directory}`);
      }
    }
    const audit = new FailingCleanupAuditLog({
      diagnostics: (message) => diagnostics.push(message),
      directory,
      retentionFiles: 1,
    });

    await audit.append(entry());
    expect(diagnostics).toEqual(['iCloud MCP audit retention cleanup failed.']);
    expect(diagnostics.join('')).not.toContain(directory);
  });

  test('preserves the active audit file when future-dated files exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    for (const date of ['2027-01-01', '2027-01-02']) {
      await writeFile(join(directory, `audit-${date}.jsonl`), '{}\n');
    }
    const audit = new LocalAuditLog({
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      directory,
      retentionFiles: 2,
    });

    await audit.append(entry());

    expect((await readdir(directory)).sort()).toEqual([
      'audit-2026-08-07.jsonl',
      'audit-2027-01-02.jsonl',
    ]);
  });

  test('retries retention cleanup after a transient failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const diagnostics: string[] = [];
    let cleanupAttempts = 0;
    class TransientCleanupAuditLog extends LocalAuditLog {
      protected override async cleanup(): Promise<void> {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error('transient cleanup failure');
        }
      }
    }
    const audit = new TransientCleanupAuditLog({
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      diagnostics: (message) => diagnostics.push(message),
      directory,
    });

    await audit.append(entry());
    await audit.append(entry());

    expect(cleanupAttempts).toBe(2);
    expect(diagnostics).toEqual(['iCloud MCP audit retention cleanup failed.']);
  });

  test('rejects a partial append before syncing it as durable', async () => {
    let synced = false;
    const handle = {
      sync: async () => {
        synced = true;
      },
      write: async (buffer: Uint8Array) => ({
        bytesWritten: buffer.byteLength - 1,
      }),
    };

    await expect(
      appendAuditLine(handle, '{"event":"synthetic"}\n'),
    ).rejects.toThrow('Incomplete iCloud MCP audit append.');
    expect(synced).toBeFalse();
  });

  test('refuses to append through a pre-existing audit-file symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const target = join(directory, 'target');
    await writeFile(target, 'must-not-change');
    await symlink(target, join(directory, 'audit-2026-08-07.jsonl'));
    const audit = new LocalAuditLog({
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      directory,
    });

    await expect(audit.append(entry())).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('must-not-change');
  });
});
