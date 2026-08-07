import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';

import { parseFolderLocator } from '../mail/locators';
import {
  ACCESS_POLICY_VERSION,
  MAIL_TOOL_NAMES,
  type AccessTransport,
  type ClientAccessPolicy,
  type HttpCredential,
  type LoadedAccessPolicy,
} from './types';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_TOKEN_CHARACTERS = 4_096;

const mailScopeSchema = z.union([
  z.literal('*'),
  z
    .object({
      folders: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

const baseClientSchema = z
  .object({
    allowBodies: z.boolean(),
    id: z.string().regex(CLIENT_ID_PATTERN),
    mailScope: mailScopeSchema,
    tools: z.array(z.enum(MAIL_TOOL_NAMES)).min(1),
  })
  .strict();

const stdioClientSchema = baseClientSchema.extend({
  transport: z.literal('stdio'),
});

const httpClientSchema = baseClientSchema.extend({
  bearerTokenEnv: z.string().regex(ENV_NAME_PATTERN),
  transport: z.literal('http'),
});

const policySchema = z
  .object({
    clients: z.array(z.union([stdioClientSchema, httpClientSchema])).min(1),
    version: z.literal(ACCESS_POLICY_VERSION),
  })
  .strict();

type Environment = Readonly<Record<string, string | undefined>>;

export interface LoadAccessPolicyOptions {
  environment?: Environment;
  repositoryRoot?: string;
  transport: AccessTransport;
}

function policyError(): Error {
  return new Error('Invalid iCloud MCP access policy.');
}

function isWithin(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

function tokenDigest(token: string): Uint8Array {
  return createHash('sha256').update(token, 'utf8').digest();
}

function validToken(token: string | undefined): token is string {
  return (
    token !== undefined &&
    token.length > 0 &&
    token.length <= MAX_TOKEN_CHARACTERS &&
    token.trim() === token &&
    !/\s/.test(token)
  );
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

async function readSecurePolicy(policyPath: string): Promise<string> {
  if (process.getuid === undefined) {
    throw policyError();
  }
  const expectedOwner = process.getuid();
  const parent = await stat(dirname(policyPath));
  if (
    !parent.isDirectory() ||
    parent.uid !== expectedOwner ||
    (parent.mode & 0o022) !== 0
  ) {
    throw policyError();
  }

  const handle = await open(
    policyPath,
    constants.O_NOFOLLOW | constants.O_RDONLY,
  );
  try {
    const file = await handle.stat();
    if (
      !file.isFile() ||
      file.uid !== expectedOwner ||
      (file.mode & 0o077) !== 0
    ) {
      throw policyError();
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function loadAccessPolicy(
  configuredPath: string | undefined,
  {
    environment = process.env,
    repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    transport,
  }: LoadAccessPolicyOptions,
): Promise<LoadedAccessPolicy> {
  if (configuredPath === undefined || !isAbsolute(configuredPath)) {
    throw policyError();
  }

  try {
    const [policyPath, repoPath] = await Promise.all([
      realpath(configuredPath),
      realpath(repositoryRoot),
    ]);
    if (isWithin(policyPath, repoPath)) {
      throw policyError();
    }

    const raw: unknown = JSON.parse(await readSecurePolicy(policyPath));
    const parsed = policySchema.parse(raw);
    if (hasDuplicate(parsed.clients.map(({ id }) => id))) {
      throw policyError();
    }

    const clients = new Map<string, ClientAccessPolicy>();
    const httpCredentials: HttpCredential[] = [];
    const httpDigests: Uint8Array[] = [];

    for (const configuredClient of parsed.clients) {
      if (hasDuplicate(configuredClient.tools)) {
        throw policyError();
      }

      const mailScope =
        configuredClient.mailScope === '*'
          ? '*'
          : configuredClient.mailScope.folders.map((locator) => ({
              address: parseFolderLocator(locator),
              locator,
            }));
      if (
        mailScope !== '*' &&
        hasDuplicate(mailScope.map(({ locator }) => locator))
      ) {
        throw policyError();
      }

      const client: ClientAccessPolicy = {
        allowBodies: configuredClient.allowBodies,
        id: configuredClient.id,
        mailScope,
        tools: new Set(configuredClient.tools),
        transport: configuredClient.transport,
        ...(configuredClient.transport === 'http'
          ? { bearerTokenEnv: configuredClient.bearerTokenEnv }
          : {}),
      };
      clients.set(client.id, client);

      if (transport === 'http' && configuredClient.transport === 'http') {
        const token = environment[configuredClient.bearerTokenEnv];
        if (!validToken(token)) {
          throw policyError();
        }
        const digest = tokenDigest(token);
        if (httpDigests.some((other) => timingSafeEqual(other, digest))) {
          throw policyError();
        }
        httpDigests.push(digest);
        httpCredentials.push({ clientId: client.id, tokenDigest: digest });
      }
    }

    return {
      clients,
      httpCredentials,
      version: ACCESS_POLICY_VERSION,
    };
  } catch (error) {
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  }
}
