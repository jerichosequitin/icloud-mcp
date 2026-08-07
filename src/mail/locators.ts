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
  mailboxId: string;
}

export interface MessageAddress extends FolderAddress {
  messageId: string;
}

function encodeLocator(kind: 'folder' | 'message', parts: readonly string[]) {
  const payload = Buffer.from(JSON.stringify(parts), 'utf8').toString(
    'base64url',
  );
  return `${LOCATOR_PREFIX}.${kind}.${payload}`;
}

function decodeLocator(
  locator: unknown,
  kind: 'folder' | 'message',
  partCount: number,
): string[] {
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
    if (
      !Array.isArray(parts) ||
      parts.length !== partCount ||
      parts.some(
        (part) =>
          typeof part !== 'string' ||
          part.length === 0 ||
          part.length > ID_CHARACTER_LIMIT,
      )
    ) {
      throw new MailAdapterError('INVALID_INPUT');
    }

    if (Buffer.from(decoded, 'utf8').toString('base64url') !== payload) {
      throw new MailAdapterError('INVALID_INPUT');
    }

    return parts as string[];
  } catch (error) {
    if (error instanceof MailAdapterError) {
      throw error;
    }
    throw new MailAdapterError('INVALID_INPUT');
  }
}

export function createFolderLocator(address: FolderAddress): MailFolderLocator {
  return encodeLocator('folder', [
    address.accountId,
    address.mailboxId,
  ]) as MailFolderLocator;
}

export function createMessageLocator(
  address: MessageAddress,
): MailMessageLocator {
  return encodeLocator('message', [
    address.accountId,
    address.mailboxId,
    address.messageId,
  ]) as MailMessageLocator;
}

export function parseFolderLocator(locator: unknown): FolderAddress {
  const [accountId, mailboxId] = decodeLocator(locator, 'folder', 2);
  return {
    accountId: accountId!,
    mailboxId: mailboxId!,
  };
}

export function parseMessageLocator(locator: unknown): MessageAddress {
  const [accountId, mailboxId, messageId] = decodeLocator(
    locator,
    'message',
    3,
  );
  return {
    accountId: accountId!,
    mailboxId: mailboxId!,
    messageId: messageId!,
  };
}
