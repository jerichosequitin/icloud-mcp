import { Buffer } from 'node:buffer';

import { MailAdapterError } from './errors';
import {
  MAIL_LIMITS,
  type MailFolderLocator,
  type MailMessageLocator,
} from './types';

const LOCATOR_PREFIX = 'icloud-mail-v1';
const ID_CHARACTER_LIMIT = 512;

export interface FolderAddress {
  accountId: string;
  mailboxPath: readonly string[];
}

export interface MessageAddress extends FolderAddress {
  messageId: string;
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ID_CHARACTER_LIMIT
  );
}

function validMailboxPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((segment) => validText(segment))
  );
}

function encodeLocator(kind: 'folder' | 'message', parts: readonly unknown[]) {
  const payload = Buffer.from(JSON.stringify(parts), 'utf8').toString(
    'base64url',
  );
  const locator = `${LOCATOR_PREFIX}.${kind}.${payload}`;
  if (locator.length > MAIL_LIMITS.locatorCharacters) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return locator;
}

function decodeLocator(
  locator: unknown,
  kind: 'folder' | 'message',
  partCount: number,
): unknown[] {
  if (
    typeof locator !== 'string' ||
    locator.length === 0 ||
    locator.length > MAIL_LIMITS.locatorCharacters
  ) {
    throw new MailAdapterError('INVALID_INPUT');
  }

  const prefix = `${LOCATOR_PREFIX}.${kind}.`;
  const payload = locator.startsWith(prefix)
    ? locator.slice(prefix.length)
    : '';
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new MailAdapterError('INVALID_INPUT');
  }

  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const parts: unknown = JSON.parse(decoded);
    if (!Array.isArray(parts) || parts.length !== partCount) {
      throw new MailAdapterError('INVALID_INPUT');
    }

    if (Buffer.from(decoded, 'utf8').toString('base64url') !== payload) {
      throw new MailAdapterError('INVALID_INPUT');
    }

    return parts;
  } catch (error) {
    if (error instanceof MailAdapterError) {
      throw error;
    }
    throw new MailAdapterError('INVALID_INPUT');
  }
}

export function createFolderLocator(address: FolderAddress): MailFolderLocator {
  if (!validText(address.accountId) || !validMailboxPath(address.mailboxPath)) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return encodeLocator('folder', [
    address.accountId,
    address.mailboxPath,
  ]) as MailFolderLocator;
}

export function createMessageLocator(
  address: MessageAddress,
): MailMessageLocator {
  if (
    !validText(address.accountId) ||
    !validMailboxPath(address.mailboxPath) ||
    !validText(address.messageId)
  ) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return encodeLocator('message', [
    address.accountId,
    address.mailboxPath,
    address.messageId,
  ]) as MailMessageLocator;
}

export function parseFolderLocator(locator: unknown): FolderAddress {
  const [accountId, mailboxPath] = decodeLocator(locator, 'folder', 2);
  if (!validText(accountId) || !validMailboxPath(mailboxPath)) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return {
    accountId,
    mailboxPath,
  };
}

export function parseMessageLocator(locator: unknown): MessageAddress {
  const [accountId, mailboxPath, messageId] = decodeLocator(
    locator,
    'message',
    3,
  );
  if (
    !validText(accountId) ||
    !validMailboxPath(mailboxPath) ||
    !validText(messageId)
  ) {
    throw new MailAdapterError('INVALID_INPUT');
  }
  return {
    accountId,
    mailboxPath,
    messageId,
  };
}
