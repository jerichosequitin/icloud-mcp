import type { AuthInfo } from '@modelcontextprotocol/server';

import type { FolderAddress } from '../mail/locators';

export const ACCESS_POLICY_VERSION = 1 as const;

export const MAIL_TOOL_NAMES = [
  'list_folders',
  'search_mail',
  'get_message_metadata',
  'get_message_bodies',
] as const;

export type MailToolName = (typeof MAIL_TOOL_NAMES)[number];
export type AccessTransport = 'http' | 'stdio';
export type ProtocolEra = 'legacy' | 'modern';

export interface FolderScopeEntry {
  address: FolderAddress;
  locator: string;
}

export type MailScope = '*' | readonly FolderScopeEntry[];

export interface ClientAccessPolicy {
  allowBodies: boolean;
  bearerTokenEnv?: string;
  id: string;
  mailScope: MailScope;
  tools: ReadonlySet<MailToolName>;
  transport: AccessTransport;
}

export interface HttpCredential {
  clientId: string;
  tokenDigest: Uint8Array;
}

export interface LoadedAccessPolicy {
  clients: ReadonlyMap<string, ClientAccessPolicy>;
  httpCredentials: readonly HttpCredential[];
  version: typeof ACCESS_POLICY_VERSION;
}

export interface AuthenticatedPrincipal {
  authInfo?: AuthInfo;
  client: ClientAccessPolicy;
  transport: AccessTransport;
}

export interface HttpAuthenticator {
  authenticate(request: Request): Promise<AuthInfo | undefined>;
}
