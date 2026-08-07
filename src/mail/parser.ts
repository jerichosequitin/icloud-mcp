import { MailAdapterError } from './errors';

type JsonRow = unknown[];

function parseRows(output: string, resultLimit: number): JsonRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  if (!Array.isArray(parsed) || parsed.length > resultLimit) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  if (parsed.some((row) => !Array.isArray(row))) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  return parsed as JsonRow[];
}

function nullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new MailAdapterError('MALFORMED_RESPONSE');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  throw new MailAdapterError('MALFORMED_RESPONSE');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  return value as string[];
}

export interface FolderRow {
  accountId: string;
  accountName: string | null;
  mailboxId: string;
  name: string | null;
}

export function parseFolderRows(
  output: string,
  resultLimit: number,
): FolderRow[] {
  return parseRows(output, resultLimit).map((row) => {
    if (row.length !== 4) {
      throw new MailAdapterError('MALFORMED_RESPONSE');
    }
    return {
      accountId: requiredString(row[0]),
      mailboxId: requiredString(row[1]),
      name: nullableString(row[2]),
      accountName: nullableString(row[3]),
    };
  });
}

export interface SearchRow {
  accountId: string;
  mailboxId: string;
  messageId: string;
  receivedDate: string | null;
  sender: string | null;
  subject: string | null;
}

export function parseSearchRows(
  output: string,
  resultLimit: number,
): SearchRow[] {
  return parseRows(output, resultLimit).map((row) => {
    if (row.length !== 6) {
      throw new MailAdapterError('MALFORMED_RESPONSE');
    }
    return {
      accountId: requiredString(row[0]),
      mailboxId: requiredString(row[1]),
      messageId: requiredString(row[2]),
      subject: nullableString(row[3]),
      sender: nullableString(row[4]),
      receivedDate: nullableString(row[5]),
    };
  });
}

export interface MetadataRow {
  bcc: string[];
  cc: string[];
  flagged: boolean | null;
  found: true;
  messageId: string | null;
  read: boolean | null;
  receivedDate: string | null;
  sender: string | null;
  sentDate: string | null;
  subject: string | null;
  to: string[];
}

export function parseMetadataRows(
  output: string,
  expectedCount: number,
): Array<MetadataRow | null> {
  const rows = parseRows(output, expectedCount);
  if (rows.length !== expectedCount) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  return rows.map((row) => {
    if (row.length === 1 && row[0] === false) {
      return null;
    }
    if (row.length !== 11 || row[0] !== true) {
      throw new MailAdapterError('MALFORMED_RESPONSE');
    }
    return {
      found: true,
      subject: nullableString(row[1]),
      sender: nullableString(row[2]),
      to: stringArray(row[3]),
      cc: stringArray(row[4]),
      bcc: stringArray(row[5]),
      messageId: nullableString(row[6]),
      receivedDate: nullableString(row[7]),
      sentDate: nullableString(row[8]),
      read: nullableBoolean(row[9]),
      flagged: nullableBoolean(row[10]),
    };
  });
}

export interface BodyRow {
  body: string | null;
  found: true;
  truncated: boolean;
}

export function parseBodyRows(
  output: string,
  expectedCount: number,
): Array<BodyRow | null> {
  const rows = parseRows(output, expectedCount);
  if (rows.length !== expectedCount) {
    throw new MailAdapterError('MALFORMED_RESPONSE');
  }
  return rows.map((row) => {
    if (row.length === 1 && row[0] === false) {
      return null;
    }
    if (row.length !== 3 || row[0] !== true || typeof row[2] !== 'boolean') {
      throw new MailAdapterError('MALFORMED_RESPONSE');
    }
    return {
      found: true,
      body: nullableString(row[1]),
      truncated: row[2],
    };
  });
}
