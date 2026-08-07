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
import { pathToFileURL } from 'node:url';

import { LocalAuditLog } from '../../src/audit';
import { appendAuditLine, withAuditFileLock } from '../../src/audit/writer';

const TEST_DATE = '2026-08-07';

function auditLockPath(directory: string): string {
  return join(directory, `.audit-${TEST_DATE}.jsonl.lock`);
}

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
  test('rejects blank and relative audit directories before resolving them', () => {
    for (const directory of ['', '   ', '.']) {
      expect(() => new LocalAuditLog({ directory })).toThrow(
        'Invalid iCloud MCP audit configuration.',
      );
    }
  });

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

  test('serializes concurrent appends from separate audit log instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    let event = 0;
    const options = {
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      directory,
      eventId: () => `cross-process-${++event}`,
    };
    const firstAudit = new LocalAuditLog(options);
    const secondAudit = new LocalAuditLog(options);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? firstAudit : secondAudit).append(entry()),
      ),
    );

    const lines = (
      await readFile(join(directory, 'audit-2026-08-07.jsonl'), 'utf8')
    )
      .trim()
      .split('\n');
    expect(lines).toHaveLength(40);
    expect(new Set(lines.map((line) => JSON.parse(line).eventId)).size).toBe(
      40,
    );
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.lock')),
    ).toEqual([`.audit-${TEST_DATE}.jsonl.lock`]);
    expect(
      await stat(auditLockPath(directory)).then(({ mode }) => mode & 0o777),
    ).toBe(0o600);
  });

  test('reclaims a valid audit lock after its owning process terminates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const lockPath = auditLockPath(directory);
    const writerModule = pathToFileURL(
      join(process.cwd(), 'src', 'audit', 'writer.ts'),
    ).href;
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { withAuditFileLock } from ${JSON.stringify(writerModule)};
await withAuditFileLock(${JSON.stringify(lockPath)}, async () => {
  console.log('locked');
  await new Promise(() => undefined);
});`,
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    const reader = child.stdout.getReader();
    try {
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain('locked');
    } finally {
      reader.releaseLock();
      child.kill('SIGKILL');
      await child.exited;
    }

    const audit = new LocalAuditLog({
      clock: () => new Date(`${TEST_DATE}T12:00:00.000Z`),
      directory,
      eventId: () => 'reclaimed-event',
    });
    await audit.append(entry());

    const record = await readFile(
      join(directory, `audit-${TEST_DATE}.jsonl`),
      'utf8',
    );
    expect(JSON.parse(record).eventId).toBe('reclaimed-event');
    expect(await readFile(lockPath, 'utf8')).toContain(
      `"pid":"${String(process.pid).padStart(10, '0')}"`,
    );
  });

  test('never reclaims a lock held by a live owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const lockPath = auditLockPath(directory);
    let markLocked: () => void = () => undefined;
    let releaseOwner: () => void = () => undefined;
    const locked = new Promise<void>((resolveLocked) => {
      markLocked = resolveLocked;
    });
    const holdOwner = new Promise<void>((resolveOwner) => {
      releaseOwner = resolveOwner;
    });
    const owner = withAuditFileLock(lockPath, async () => {
      markLocked();
      await holdOwner;
    });
    await locked;

    try {
      await expect(
        withAuditFileLock(lockPath, async () => undefined, {
          retryDelay: async () => undefined,
          retryLimit: 2,
        }),
      ).rejects.toThrow('Unable to acquire iCloud MCP audit lock.');
    } finally {
      releaseOwner();
      await owner;
    }
  });

  test('fails closed for malformed or insecure audit lock files', async () => {
    const malformedDirectory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const malformedPath = auditLockPath(malformedDirectory);
    await writeFile(malformedPath, '{}\n', { mode: 0o600 });
    await expect(
      withAuditFileLock(malformedPath, async () => undefined),
    ).rejects.toThrow('Invalid iCloud MCP audit lock.');
    expect(await readFile(malformedPath, 'utf8')).toBe('{}\n');

    const insecureDirectory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const insecurePath = auditLockPath(insecureDirectory);
    await withAuditFileLock(insecurePath, async () => undefined);
    await chmod(insecurePath, 0o666);
    await expect(
      withAuditFileLock(insecurePath, async () => undefined),
    ).rejects.toThrow('Invalid iCloud MCP audit lock.');
  });

  test('allows only one contender to reclaim and enter a stale lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'icloud-audit-'));
    const lockPath = auditLockPath(directory);
    await withAuditFileLock(lockPath, async () => undefined);
    let active = 0;
    let maximumActive = 0;
    const entered: number[] = [];

    await Promise.all(
      [1, 2].map((contender) =>
        withAuditFileLock(lockPath, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entered.push(contender);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          active -= 1;
        }),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(entered.sort()).toEqual([1, 2]);
    const lockContents = await readFile(lockPath, 'utf8');
    expect(lockContents).toMatch(
      /^\{"ownerId":"[0-9a-f-]+","pid":"\d{10}","schemaVersion":1\}\n$/,
    );
    for (const forbidden of [
      'client',
      'token',
      'locator',
      'query',
      'subject',
      'body',
    ]) {
      expect(lockContents.toLowerCase()).not.toContain(forbidden);
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
      '.audit-2026-08-04.jsonl.lock',
      '.audit-2026-08-05.jsonl.lock',
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
      '.audit-2026-08-07.jsonl.lock',
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

  test('repairs a partial append to the known safe boundary', async () => {
    const safeBoundary = 128;
    let size = safeBoundary;
    const truncations: number[] = [];
    let syncCount = 0;
    const handle = {
      stat: async () => ({ size }),
      sync: async () => {
        syncCount += 1;
      },
      truncate: async (length: number) => {
        truncations.push(length);
        size = length;
      },
      write: async (buffer: Uint8Array) => {
        const bytesWritten = buffer.byteLength - 1;
        size += bytesWritten;
        return { bytesWritten };
      },
    };

    await expect(
      appendAuditLine(handle, '{"event":"synthetic"}\n'),
    ).rejects.toThrow('Incomplete iCloud MCP audit append.');
    expect(size).toBe(safeBoundary);
    expect(truncations).toEqual([safeBoundary]);
    expect(syncCount).toBe(1);
  });

  test('repairs a write failure after partial bytes without truncating complete records', async () => {
    const completeRecord = '{"event":"complete"}\n';
    const failedRecord = '{"event":"failed"}\n';
    let contents = completeRecord;
    const safeBoundary = Buffer.byteLength(completeRecord);
    const handle = {
      stat: async () => ({ size: Buffer.byteLength(contents) }),
      sync: async () => undefined,
      truncate: async (length: number) => {
        contents = Buffer.from(contents).subarray(0, length).toString('utf8');
      },
      write: async (buffer: Uint8Array) => {
        contents += Buffer.from(buffer).subarray(0, 5).toString('utf8');
        throw new Error('synthetic write failure');
      },
    };

    await expect(appendAuditLine(handle, failedRecord)).rejects.toThrow(
      'synthetic write failure',
    );
    expect(Buffer.byteLength(contents)).toBe(safeBoundary);
    expect(contents).toBe(completeRecord);
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
