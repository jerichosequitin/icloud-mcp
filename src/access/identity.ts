import type { AuthInfo } from '@modelcontextprotocol/server';

import type { AuthenticatedPrincipal, LoadedAccessPolicy } from './types';

function startupError(): Error {
  return new Error('Invalid iCloud MCP client identity.');
}

export function resolveStdioPrincipal(
  policy: LoadedAccessPolicy,
  clientId: string | undefined,
): AuthenticatedPrincipal {
  if (clientId === undefined) {
    throw startupError();
  }
  const client = policy.clients.get(clientId);
  if (client === undefined || client.transport !== 'stdio') {
    throw startupError();
  }
  return { client, transport: 'stdio' };
}

export function resolveHttpPrincipal(
  policy: LoadedAccessPolicy,
  authInfo: AuthInfo,
): AuthenticatedPrincipal | undefined {
  const client = policy.clients.get(authInfo.clientId);
  if (client === undefined || client.transport !== 'http') {
    return undefined;
  }
  return { authInfo, client, transport: 'http' };
}
