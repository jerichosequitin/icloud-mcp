import {
  close as closeDescriptor,
  constants,
  fchmod,
  fstat,
  fsync,
  ftruncate,
  read,
  write,
} from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';

import { MAIL_TOOL_NAMES } from '../access/types';
import {
  AUDIT_REASON_CODES,
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
const OPEN_CLOSE_ON_EXEC =
  process.platform === 'darwin' ? 0x01000000 : 0x00080000;
const MAX_AUDIT_RECORD_BYTES = 16_384;
const MAX_AUDIT_TAIL_BYTES = MAX_AUDIT_RECORD_BYTES * 2 + 2;
const libc = dlopen(
  process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
  {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
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
  directorySync?: (handle: FileHandle) => Promise<void>;
  eventId?: () => string;
  retentionFiles?: number;
}

interface AuditFileHandle {
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
}

interface AuditTailHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
}

interface SecureAuditFileHandle extends AuditFileHandle, AuditTailHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  readonly fd: number;
  stat(): Promise<{
    dev: number;
    ino: number;
    isFile(): boolean;
    mode: number;
    nlink: number;
    size: number;
    uid: number;
  }>;
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

function invalidAuditTail(): Error {
  return new Error('Invalid iCloud MCP audit file tail.');
}

async function readAuditTail(
  handle: AuditTailHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead,
    );
    if (result.bytesRead <= 0) {
      throw invalidAuditTail();
    }
    bytesRead += result.bytesRead;
  }
  return buffer;
}

function previousNewline(buffer: Buffer, beforeExclusive: number): number {
  return beforeExclusive <= 0
    ? -1
    : buffer.lastIndexOf(0x0a, beforeExclusive - 1);
}

function validateCompleteAuditRecord(
  buffer: Buffer,
  boundary: number,
  fileOffset: number,
): void {
  const previousBoundary = previousNewline(buffer, boundary);
  if (previousBoundary < 0 && fileOffset > 0) {
    throw invalidAuditTail();
  }
  const recordStart = previousBoundary + 1;
  const recordLength = boundary - recordStart;
  if (recordLength <= 0 || recordLength > MAX_AUDIT_RECORD_BYTES) {
    throw invalidAuditTail();
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(recordStart, boundary),
    );
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw invalidAuditTail();
    }
    const record = parsed as Record<string, unknown>;
    const expectedKeys = [
      'clientId',
      'decision',
      'eventId',
      'protocolEra',
      'reason',
      'schemaVersion',
      'timestamp',
      'tool',
      'transport',
    ];
    if (
      Object.keys(record).length !== expectedKeys.length ||
      expectedKeys.some((key) => !(key in record)) ||
      typeof record.clientId !== 'string' ||
      record.clientId.length === 0 ||
      (record.decision !== 'allow' && record.decision !== 'deny') ||
      typeof record.eventId !== 'string' ||
      record.eventId.length === 0 ||
      (record.protocolEra !== 'legacy' && record.protocolEra !== 'modern') ||
      !AUDIT_REASON_CODES.includes(record.reason as never) ||
      record.schemaVersion !== AUDIT_SCHEMA_VERSION ||
      typeof record.timestamp !== 'string' ||
      !MAIL_TOOL_NAMES.includes(record.tool as never) ||
      (record.transport !== 'http' && record.transport !== 'stdio')
    ) {
      throw invalidAuditTail();
    }
    if (new Date(record.timestamp).toISOString() !== record.timestamp) {
      throw invalidAuditTail();
    }
  } catch {
    throw invalidAuditTail();
  }
}

export async function validateAndRepairAuditTail(
  handle: AuditTailHandle,
): Promise<void> {
  const { size } = await handle.stat();
  if (!Number.isSafeInteger(size) || size < 0) {
    throw invalidAuditTail();
  }
  if (size === 0) {
    return;
  }

  const tailLength = Math.min(size, MAX_AUDIT_TAIL_BYTES);
  const tailOffset = size - tailLength;
  const tail = await readAuditTail(handle, tailOffset, tailLength);
  const endsWithNewline = tail.at(-1) === 0x0a;
  const lastBoundary = endsWithNewline
    ? tail.length - 1
    : tail.lastIndexOf(0x0a);

  if (endsWithNewline) {
    validateCompleteAuditRecord(tail, lastBoundary, tailOffset);
    return;
  }

  const fragmentStart = lastBoundary + 1;
  const fragmentLength = tail.length - fragmentStart;
  if (
    fragmentLength <= 0 ||
    fragmentLength > MAX_AUDIT_RECORD_BYTES ||
    (lastBoundary < 0 && tailOffset > 0)
  ) {
    throw invalidAuditTail();
  }
  if (lastBoundary >= 0) {
    validateCompleteAuditRecord(tail, lastBoundary, tailOffset);
  }

  const safeBoundary = tailOffset + fragmentStart;
  try {
    await handle.truncate(safeBoundary);
    await handle.sync();
  } catch (error) {
    throw new Error('Unable to repair iCloud MCP audit file tail.', {
      cause: error,
    });
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

interface DirectorySnapshot {
  dev: number;
  ino: number;
  path: string;
}

interface SecureAuditDirectory {
  handle: FileHandle;
  validate(): Promise<void>;
}

interface SecureAuditDirectoryOptions {
  beforeOpen?: () => Promise<void>;
}

function pathComponents(path: string): string[] {
  const { root } = parse(path);
  const names = path.slice(root.length).split(sep).filter(Boolean);
  const components = [root];
  for (const name of names) {
    components.push(join(components.at(-1)!, name));
  }
  return components;
}

function sameFile(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function validDirectory(
  directory: {
    isDirectory(): boolean;
    mode: number;
    uid: number;
  },
  expectedOwner: number,
  final: boolean,
): boolean {
  if (!directory.isDirectory()) {
    return false;
  }
  const mode = directory.mode & 0o7777;
  if (final) {
    return directory.uid === expectedOwner && mode === 0o700;
  }
  const trustedOwner = directory.uid === 0 || directory.uid === expectedOwner;
  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  return trustedOwner && (!writableByOthers || sticky);
}

async function validateDirectorySnapshots(
  snapshots: readonly DirectorySnapshot[],
  expectedOwner: number,
): Promise<void> {
  for (const [index, snapshot] of snapshots.entries()) {
    const current = await lstat(snapshot.path);
    if (
      !sameFile(current, snapshot) ||
      !validDirectory(current, expectedOwner, index === snapshots.length - 1)
    ) {
      throw new Error('Invalid iCloud MCP audit directory.');
    }
  }
}

export async function openSecureAuditDirectory(
  directory: string,
  { beforeOpen }: SecureAuditDirectoryOptions = {},
): Promise<SecureAuditDirectory> {
  const expectedOwner = process.getuid?.();
  if (expectedOwner === undefined) {
    throw new Error('Invalid iCloud MCP audit directory.');
  }

  const components = pathComponents(directory);
  const snapshots: DirectorySnapshot[] = [];
  for (const [index, component] of components.entries()) {
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(component);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || index === 0) {
        throw new Error('Invalid iCloud MCP audit directory.', {
          cause: error,
        });
      }
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') {
          throw new Error('Invalid iCloud MCP audit directory.', {
            cause: mkdirError,
          });
        }
      }
      current = await lstat(component);
    }
    if (
      !validDirectory(current, expectedOwner, index === components.length - 1)
    ) {
      throw new Error('Invalid iCloud MCP audit directory.');
    }
    snapshots.push({ dev: current.dev, ino: current.ino, path: component });
  }

  await beforeOpen?.();
  const handle = await open(
    directory,
    constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
  );
  try {
    const opened = await handle.stat();
    const finalSnapshot = snapshots.at(-1)!;
    if (
      !sameFile(opened, finalSnapshot) ||
      !validDirectory(opened, expectedOwner, true)
    ) {
      throw new Error('Invalid iCloud MCP audit directory.');
    }
    await validateDirectorySnapshots(snapshots, expectedOwner);
    return {
      handle,
      validate: () => validateDirectorySnapshots(snapshots, expectedOwner),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

class DescriptorAuditFileHandle implements SecureAuditFileHandle {
  constructor(readonly fd: number) {}

  chmod(mode: number): Promise<void> {
    return new Promise((resolveChmod, rejectChmod) => {
      fchmod(this.fd, mode, (error) =>
        error === null ? resolveChmod() : rejectChmod(error),
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolveClose, rejectClose) => {
      closeDescriptor(this.fd, (error) =>
        error === null ? resolveClose() : rejectClose(error),
      );
    });
  }

  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return new Promise((resolveRead, rejectRead) => {
      read(this.fd, buffer, offset, length, position, (error, bytesRead) =>
        error === null ? resolveRead({ bytesRead }) : rejectRead(error),
      );
    });
  }

  stat(): ReturnType<SecureAuditFileHandle['stat']> {
    return new Promise((resolveStat, rejectStat) => {
      fstat(this.fd, (error, stats) =>
        error === null ? resolveStat(stats) : rejectStat(error),
      );
    });
  }

  sync(): Promise<void> {
    return new Promise((resolveSync, rejectSync) => {
      fsync(this.fd, (error) =>
        error === null ? resolveSync() : rejectSync(error),
      );
    });
  }

  truncate(length: number): Promise<void> {
    return new Promise((resolveTruncate, rejectTruncate) => {
      ftruncate(this.fd, length, (error) =>
        error === null ? resolveTruncate() : rejectTruncate(error),
      );
    });
  }

  write(buffer: Uint8Array): Promise<{ bytesWritten: number }> {
    return new Promise((resolveWrite, rejectWrite) => {
      write(this.fd, buffer, (error, bytesWritten) =>
        error === null ? resolveWrite({ bytesWritten }) : rejectWrite(error),
      );
    });
  }
}

function openAuditFileAt(
  directoryHandle: FileHandle,
  filename: string,
  flags: number,
): SecureAuditFileHandle {
  const encodedFilename = Buffer.from(`${filename}\0`, 'utf8');
  const descriptor = libc.symbols.openat(
    directoryHandle.fd,
    encodedFilename,
    flags | OPEN_CLOSE_ON_EXEC | constants.O_NOFOLLOW,
    0o600,
  );
  if (descriptor < 0) {
    throw new Error('Unable to open iCloud MCP audit file.');
  }
  return new DescriptorAuditFileHandle(descriptor);
}

async function openSecureAuditFile(
  directoryHandle: FileHandle,
  filename: string,
  path: string,
): Promise<{ created: boolean; handle: SecureAuditFileHandle }> {
  if (!AUDIT_FILENAME_PATTERN.test(filename)) {
    throw new Error('Invalid iCloud MCP audit file.');
  }

  let existing: { dev: number; ino: number } | undefined;
  try {
    const current = await lstat(path);
    existing = { dev: current.dev, ino: current.ino };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const created = existing === undefined;
  const handle = openAuditFileAt(
    directoryHandle,
    filename,
    constants.O_APPEND |
      constants.O_RDWR |
      (created ? constants.O_CREAT | constants.O_EXCL : 0),
  );
  if (existing !== undefined) {
    try {
      const opened = await handle.stat();
      if (sameFile(opened, existing)) {
        return { created, handle };
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
    throw new Error('Invalid iCloud MCP audit file.');
  }
  return { created, handle };
}

async function validateAuditFile(
  handle: SecureAuditFileHandle,
  path: string,
  expectedOwner: number,
): Promise<void> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
  if (
    !opened.isFile() ||
    !current.isFile() ||
    !sameFile(opened, current) ||
    opened.uid !== expectedOwner ||
    current.uid !== expectedOwner ||
    (opened.mode & 0o777) !== 0o600 ||
    (current.mode & 0o777) !== 0o600 ||
    opened.nlink !== 1 ||
    current.nlink !== 1
  ) {
    throw new Error('Invalid iCloud MCP audit file.');
  }
}

export function defaultAuditDirectory(): string {
  return join(homedir(), 'Library', 'Logs', 'icloud-mcp');
}

export class LocalAuditLog implements AuditLog {
  readonly #clock: () => Date;
  readonly #diagnostics: (message: string) => void;
  readonly #directory: string;
  readonly #directorySync: (handle: FileHandle) => Promise<void>;
  readonly #eventId: () => string;
  readonly #retentionFiles: number;
  #lastCleanupDate?: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor({
    clock = () => new Date(),
    diagnostics = (message) => console.error(message),
    directory = defaultAuditDirectory(),
    directorySync = (handle) => handle.sync(),
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
    this.#directorySync = directorySync;
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

    const directory = await openSecureAuditDirectory(this.#directory);
    try {
      await withAuditFileLock(
        join(this.#directory, `.${activeFilename}.lock`),
        async () => {
          await directory.validate();
          const auditPath = join(this.#directory, activeFilename);
          const { created, handle } = await openSecureAuditFile(
            directory.handle,
            activeFilename,
            auditPath,
          );
          try {
            const expectedOwner = process.getuid?.();
            if (expectedOwner === undefined) {
              throw new Error('Invalid iCloud MCP audit file.');
            }
            if (created) {
              await handle.chmod(0o600);
            }
            await validateAuditFile(handle, auditPath, expectedOwner);
            if (created) {
              await this.#directorySync(directory.handle);
            }
            await directory.validate();
            await validateAndRepairAuditTail(handle);
            await validateAuditFile(handle, auditPath, expectedOwner);
            await appendAuditLine(handle, line);
            await validateAuditFile(handle, auditPath, expectedOwner);
            await directory.validate();
          } finally {
            await handle.close();
          }
        },
      );

      if (this.#lastCleanupDate !== date) {
        try {
          await directory.validate();
          await this.cleanup(activeFilename);
          await directory.validate();
          this.#lastCleanupDate = date;
        } catch {
          this.#diagnostics('iCloud MCP audit retention cleanup failed.');
        }
      }
    } finally {
      await directory.handle.close();
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
