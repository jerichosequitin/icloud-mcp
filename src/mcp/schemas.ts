import { z } from 'zod/v4';

import { parseFolderLocator, parseMessageLocator } from '../mail/locators';
import { MAIL_LIMITS } from '../mail/types';

function acceptsLocator(
  value: string,
  parse: (locator: unknown) => unknown,
): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

const folderLocatorSchema = z
  .string()
  .min(1)
  .max(MAIL_LIMITS.locatorCharacters)
  .refine((value) => acceptsLocator(value, parseFolderLocator), {
    error: 'Invalid folder locator.',
  })
  .describe('Opaque folder locator returned by list_folders.');

const messageLocatorSchema = z
  .string()
  .min(1)
  .max(MAIL_LIMITS.locatorCharacters)
  .refine((value) => acceptsLocator(value, parseMessageLocator), {
    error: 'Invalid message locator.',
  })
  .describe('Opaque message locator returned by search_mail.');

const nullableTextSchema = z.string().nullable();

const folderSchema = z
  .object({
    accountName: nullableTextSchema,
    locator: z.string().min(1).max(MAIL_LIMITS.locatorCharacters),
    name: nullableTextSchema,
  })
  .strict();

const searchResultSchema = z
  .object({
    locator: z.string().min(1).max(MAIL_LIMITS.locatorCharacters),
    receivedDate: nullableTextSchema,
    sender: nullableTextSchema,
    subject: nullableTextSchema,
  })
  .strict();

const metadataSchema = z
  .object({
    bcc: z.array(z.string()),
    cc: z.array(z.string()),
    flagged: z.boolean().nullable(),
    locator: z.string().min(1).max(MAIL_LIMITS.locatorCharacters),
    messageId: nullableTextSchema,
    read: z.boolean().nullable(),
    receivedDate: nullableTextSchema,
    sender: nullableTextSchema,
    sentDate: nullableTextSchema,
    subject: nullableTextSchema,
    to: z.array(z.string()),
  })
  .strict();

const bodySchema = z
  .object({
    body: z.string().max(MAIL_LIMITS.bodyCharacters).nullable(),
    locator: z.string().min(1).max(MAIL_LIMITS.locatorCharacters),
    truncated: z.boolean(),
  })
  .strict();

export const listFoldersInputSchema = z
  .object({
    limit: z.number().int().min(1).max(MAIL_LIMITS.folders).optional(),
  })
  .strict();

export const listFoldersOutputSchema = z
  .object({
    folders: z.array(folderSchema).max(MAIL_LIMITS.folders),
    truncated: z.boolean(),
  })
  .strict();

export const searchMailInputSchema = z
  .object({
    field: z.enum(['recipient', 'sender', 'subject']),
    folder: folderLocatorSchema,
    limit: z.number().int().min(1).max(MAIL_LIMITS.searchResults).optional(),
    query: z
      .string()
      .max(MAIL_LIMITS.queryCharacters)
      .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
        error: 'Invalid mail search query.',
      }),
  })
  .strict();

export const searchMailOutputSchema = z
  .object({
    messages: z.array(searchResultSchema).max(MAIL_LIMITS.searchResults),
    truncated: z.boolean(),
  })
  .strict();

export const getMessageMetadataInputSchema = z
  .object({
    locators: z
      .array(messageLocatorSchema)
      .min(1)
      .max(MAIL_LIMITS.metadataMessages),
  })
  .strict();

export const getMessageMetadataOutputSchema = z
  .object({
    messages: z.array(metadataSchema).max(MAIL_LIMITS.metadataMessages),
    missingLocators: z
      .array(z.string().min(1).max(MAIL_LIMITS.locatorCharacters))
      .max(MAIL_LIMITS.metadataMessages),
  })
  .strict();

export const getMessageBodiesInputSchema = z
  .object({
    locators: z
      .array(messageLocatorSchema)
      .min(1)
      .max(MAIL_LIMITS.bodyMessages),
    maxCharacters: z
      .number()
      .int()
      .min(1)
      .max(MAIL_LIMITS.bodyCharacters)
      .optional(),
  })
  .strict();

export const getMessageBodiesOutputSchema = z
  .object({
    messages: z.array(bodySchema).max(MAIL_LIMITS.bodyMessages),
    missingLocators: z
      .array(z.string().min(1).max(MAIL_LIMITS.locatorCharacters))
      .max(MAIL_LIMITS.bodyMessages),
  })
  .strict();
