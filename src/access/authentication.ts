import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';

import type {
  HttpAuthenticator,
  HttpCredential,
  LoadedAccessPolicy,
} from './types';

const MAX_BEARER_TOKEN_CHARACTERS = 4_096;

function digestToken(token: string): Uint8Array {
  return createHash('sha256').update(token, 'utf8').digest();
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_BEARER_TOKEN_CHARACTERS
    ? token
    : undefined;
}

export class LocalBearerAuthenticator implements HttpAuthenticator {
  readonly #credentials: readonly HttpCredential[];

  constructor(credentials: readonly HttpCredential[]) {
    this.#credentials = credentials;
  }

  async authenticate(request: Request): Promise<AuthInfo | undefined> {
    const token = bearerToken(request);
    if (token === undefined) {
      return undefined;
    }

    const presentedDigest = digestToken(token);
    let clientId: string | undefined;
    for (const credential of this.#credentials) {
      if (timingSafeEqual(presentedDigest, credential.tokenDigest)) {
        clientId = credential.clientId;
      }
    }
    if (clientId === undefined) {
      return undefined;
    }
    return { clientId, scopes: [], token };
  }
}

export function createLocalBearerAuthenticator(
  policy: LoadedAccessPolicy,
): HttpAuthenticator {
  return new LocalBearerAuthenticator(policy.httpCredentials);
}
