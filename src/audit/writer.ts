import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';

import {
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  type AuditEntryInput,
} from './schema';

const AUDIT_FILENAME_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const AUDIT_LOCK_RETRY_DELAY_MS = 5;
const AUDIT_LOCK_RETRY_LIMIT = 200;
const AUDIT_LOCK_SCHEMA_VERSION = 1;
const AUDIT_LOCK_METADATA_PATTERN =
  /^\{"ownerId":"([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})","pid":"(\d{10})","schemaVersion":1\}\n$/;
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCK_RELEASE = 8;
const libc = dlopen(
  process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
  {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  },
);
export const DEFAULT_AUDIT_RETENTION_FILES = 30;

export interface AuditLog {
  append(entry: AuditEntryInput): Promise<void>;
}

export interface LocalAuditLogOptions {
  clock?: () => Date;
  diagnostics?: (message: string) => void;
  directory?: string;
  eventId?: () => string;
  retentionFiles?: number;
}

interface AuditFileHandle {
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
}

async function repairIncompleteAppend(
  handle: AuditFileHandle,
  safeBoundary: number,
  completeBoundary: number,
): Promise<void> {
  const { size } = await handle.stat();
  if (size === safeBoundary || size === completeBoundary) {
    return;
  }
  if (size < safeBoundary || size > completeBoundary) {
    throw new Error('Unable to repair iCloud MCP audit append.');
  }
  await handle.truncate(safeBoundary);
  await handle.sync();
}

export async function appendAuditLine(
  handle: AuditFileHandle,
  line: string,
): Promise<void> {
  const encodedLine = Buffer.from(line, 'utf8');
  const safeBoundary = (await handle.stat()).size;
  let writeComplete = false;
  try {
    const { bytesWritten } = await handle.write(encodedLine);
    writeComplete = bytesWritten === encodedLine.byteLength;
    if (!writeComplete) {
      throw new Error('Incomplete iCloud MCP audit append.');
    }
    await handle.sync();
  } catch (error) {
    if (!writeComplete) {
      try {
        await repairIncompleteAppend(
          handle,
          safeBoundary,
          safeBoundary + encodedLine.byteLength,
        );
      } catch {
        throw new Error('Unable to repair iCloud MCP audit append.');
      }
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return String(error.code);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface AuditFileLockOptions {
  retryDelay?: () => Promise<void>;
  retryLimit?: number;
}

interface AuditLockMetadata {
  ownerId: string;
  pid: string;
  schemaVersion: typeof AUDIT_LOCK_SCHEMA_VERSION;
}

type LockHandle = Awaited<ReturnType<typeof open>>;

function newLockMetadata(): AuditLockMetadata {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw new Error('Invalid iCloud MCP audit lock owner.');
  }
  return {
    ownerId: randomUUID(),
    pid: String(process.pid).padStart(10, '0'),
    schemaVersion: AUDIT_LOCK_SCHEMA_VERSION,
  };
}

function serializeLockMetadata(metadata: AuditLockMetadata): Buffer {
  if (metadata.pid.length !== 10) {
    throw new Error('Invalid iCloud MCP audit lock owner.');
  }
  return Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8');
}

function validLockMetadata(contents: string): boolean {
  const match = AUDIT_LOCK_METADATA_PATTERN.exec(contents);
  if (match === null) {
    return false;
  }
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0;
}

function tryLock(handle: LockHandle): boolean {
  return libc.symbols.flock(handle.fd, LOCK_EXCLUSIVE_NONBLOCKING) === 0;
}

function releaseLock(handle: LockHandle): boolean {
  return libc.symbols.flock(handle.fd, LOCK_RELEASE) === 0;
}

async function writeLockMetadata(
  handle: LockHandle,
  encodedMetadata: Buffer,
): Promise<void> {
  const { bytesWritten } = await handle.write(
    encodedMetadata,
    0,
    encodedMetadata.byteLength,
    0,
  );
  if (bytesWritten !== encodedMetadata.byteLength) {
    throw new Error('Unable to write iCloud MCP audit lock.');
  }
  await handle.sync();
}

async function createLockedAuditFile(
  lockPath: string,
  metadata: AuditLockMetadata,
  encodedMetadata: Buffer,
): Promise<LockHandle | undefined> {
  const candidatePath = `${lockPath}.${metadata.ownerId}.candidate`;
  const handle = await open(
    candidatePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_RDWR,
    0o600,
  );
  let published = false;
  try {
    if (!tryLock(handle)) {
      throw new Error('Unable to acquire iCloud MCP audit lock.');
    }
    await handle.chmod(0o600);
    await writeLockMetadata(handle, encodedMetadata);
    try {
      await link(candidatePath, lockPath);
      published = true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
    return published ? handle : undefined;
  } finally {
    await unlink(candidatePath).catch(() => undefined);
    if (!published) {
      await handle.close();
    }
  }
}

async function openExistingAuditLock(
  lockPath: string,
  encodedMetadata: Buffer,
): Promise<LockHandle | undefined> {
  let handle: LockHandle;
  try {
    handle = await open(lockPath, constants.O_NOFOLLOW | constants.O_RDWR);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  let acquired = false;
  let keepHandle = false;
  try {
    const file = await handle.stat();
    const expectedOwner = process.getuid?.();
    if (
      expectedOwner === undefined ||
      !file.isFile() ||
      file.uid !== expectedOwner ||
      (file.mode & 0o777) !== 0o600 ||
      file.size <= 0 ||
      file.size > 256
    ) {
      throw new Error('Invalid iCloud MCP audit lock.');
    }
    if (!tryLock(handle)) {
      return undefined;
    }
    acquired = true;
    const contents = await handle.readFile('utf8');
    if (!validLockMetadata(contents)) {
      throw new Error('Invalid iCloud MCP audit lock.');
    }
    await writeLockMetadata(handle, encodedMetadata);
    keepHandle = true;
    return handle;
  } finally {
    if (!keepHandle) {
      if (acquired) {
        releaseLock(handle);
      }
      await handle.close();
    }
  }
}

export async function withAuditFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  {
    retryDelay = () => delay(AUDIT_LOCK_RETRY_DELAY_MS),
    retryLimit = AUDIT_LOCK_RETRY_LIMIT,
  }: AuditFileLockOptions = {},
): Promise<T> {
  const metadata = newLockMetadata();
  const encodedMetadata = serializeLockMetadata(metadata);
  let lockHandle: LockHandle | undefined;
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    lockHandle = await createLockedAuditFile(
      lockPath,
      metadata,
      encodedMetadata,
    );
    lockHandle ??= await openExistingAuditLock(lockPath, encodedMetadata);
    if (lockHandle !== undefined) {
      break;
    }
    await retryDelay();
  }
  if (lockHandle === undefined) {
    throw new Error('Unable to acquire iCloud MCP audit lock.');
  }

  let operationResult: T | undefined;
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  const releaseFailed = !releaseLock(lockHandle);
  let closeFailed = false;
  try {
    await lockHandle.close();
  } catch {
    closeFailed = true;
  }
  if (releaseFailed || closeFailed) {
    throw new Error('Unable to release iCloud MCP audit lock.');
  }
  if (operationFailed) {
    throw operationFailure;
  }
  return operationResult as T;
}

function validRetention(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 366;
}

export function defaultAuditDirectory(): string {
  return join(homedir(), 'Library', 'Logs', 'icloud-mcp');
}

export class LocalAuditLog implements AuditLog {
  readonly #clock: () => Date;
  readonly #diagnostics: (message: string) => void;
  readonly #directory: string;
  readonly #eventId: () => string;
  readonly #retentionFiles: number;
  #lastCleanupDate?: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor({
    clock = () => new Date(),
    diagnostics = (message) => console.error(message),
    directory = defaultAuditDirectory(),
    eventId = randomUUID,
    retentionFiles = DEFAULT_AUDIT_RETENTION_FILES,
  }: LocalAuditLogOptions = {}) {
    if (
      directory.trim().length === 0 ||
      !isAbsolute(directory) ||
      !validRetention(retentionFiles)
    ) {
      throw new Error('Invalid iCloud MCP audit configuration.');
    }
    this.#clock = clock;
    this.#diagnostics = diagnostics;
    this.#directory = resolve(directory);
    this.#eventId = eventId;
    this.#retentionFiles = retentionFiles;
  }

  append(input: AuditEntryInput): Promise<void> {
    const operation = this.#writeQueue.then(
      () => this.#append(input),
      () => this.#append(input),
    );
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #append(input: AuditEntryInput): Promise<void> {
    const now = this.#clock();
    const timestamp = now.toISOString();
    const date = timestamp.slice(0, 10);
    const activeFilename = `audit-${date}.jsonl`;
    const entry: AuditEntry = {
      ...input,
      eventId: this.#eventId(),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      timestamp,
    };
    const line = `${JSON.stringify(entry)}\n`;

    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    if (!(await lstat(this.#directory)).isDirectory()) {
      throw new Error('Invalid iCloud MCP audit directory.');
    }
    await chmod(this.#directory, 0o700);
    await withAuditFileLock(
      join(this.#directory, `.${activeFilename}.lock`),
      async () => {
        const handle = await open(
          join(this.#directory, activeFilename),
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_WRONLY,
          0o600,
        );
        try {
          if (!(await handle.stat()).isFile()) {
            throw new Error('Invalid iCloud MCP audit file.');
          }
          await handle.chmod(0o600);
          await appendAuditLine(handle, line);
        } finally {
          await handle.close();
        }
      },
    );

    if (this.#lastCleanupDate !== date) {
      try {
        await this.cleanup(activeFilename);
        this.#lastCleanupDate = date;
      } catch {
        this.#diagnostics('iCloud MCP audit retention cleanup failed.');
      }
    }
  }

  protected async cleanup(activeFilename: string): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const auditFiles = entries
      .filter(
        (entry) => entry.isFile() && AUDIT_FILENAME_PATTERN.test(entry.name),
      )
      .map(({ name }) => name)
      .sort()
      .reverse();
    const inactiveFiles = auditFiles.filter(
      (filename) => filename !== activeFilename,
    );
    for (const filename of inactiveFiles.slice(this.#retentionFiles - 1)) {
      await unlink(join(this.#directory, filename));
    }
  }
}
