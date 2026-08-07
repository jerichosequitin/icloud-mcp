import {
  createMcpHandler,
  hostHeaderValidationResponse,
} from '@modelcontextprotocol/server';

import {
  createLocalBearerAuthenticator,
  loadAccessPolicy,
  resolveHttpPrincipal,
  type HttpAuthenticator,
  type LoadedAccessPolicy,
} from '../access';
import { LocalAuditLog, type AuditLog } from '../audit';
import { AppleMailAdapter } from '../mail/adapter';
import { createMailMcpServer } from '../mcp/server';
import type { MailMcpAdapter } from '../mcp/tools';

export const MAIL_HTTP_HOST = '127.0.0.1';
export const MAIL_HTTP_PATH = '/mcp';
export const MAIL_HTTP_DEFAULT_PORT = 3000;

const ALLOWED_HOSTNAMES = [MAIL_HTTP_HOST, 'localhost'];

export interface MailHttpHandler {
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

interface CreateMailHttpHandlerOptions {
  adapter: MailMcpAdapter;
  audit: AuditLog;
  authenticator?: HttpAuthenticator;
  diagnostics?: (message: string) => void;
  policy: LoadedAccessPolicy;
}

interface StartMailHttpServerOptions extends CreateMailHttpHandlerOptions {
  port?: number;
}

function unauthorizedResponse(): Response {
  return new Response('Unauthorized.', {
    headers: { 'WWW-Authenticate': 'Bearer' },
    status: 401,
  });
}

export function parseMailHttpPort(value: string | undefined): number {
  if (value === undefined) {
    return MAIL_HTTP_DEFAULT_PORT;
  }
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error('Invalid local MCP HTTP port.');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid local MCP HTTP port.');
  }
  return port;
}

export function createMailHttpHandler({
  adapter,
  audit,
  authenticator,
  diagnostics = (message) => console.error(message),
  policy,
}: CreateMailHttpHandlerOptions): MailHttpHandler {
  const activeAuthenticator =
    authenticator ?? createLocalBearerAuthenticator(policy);
  const handler = createMcpHandler(
    ({ authInfo, era }) => {
      if (authInfo === undefined) {
        throw new Error('Missing authenticated principal.');
      }
      const principal = resolveHttpPrincipal(policy, authInfo);
      if (principal === undefined) {
        throw new Error('Unknown authenticated principal.');
      }
      return createMailMcpServer({
        adapter,
        audit,
        diagnostics,
        principal,
        protocolEra: era,
      });
    },
    {
      legacy: 'stateless',
      onerror: () => diagnostics('MCP HTTP transport error.'),
      responseMode: 'auto',
    },
  );
  return {
    close: handler.close,
    async fetch(request) {
      const hostFailure = hostHeaderValidationResponse(
        request,
        ALLOWED_HOSTNAMES,
      );
      if (hostFailure !== undefined) {
        return hostFailure;
      }
      if (new URL(request.url).pathname !== MAIL_HTTP_PATH) {
        return new Response('Not found.', { status: 404 });
      }
      const authInfo = await activeAuthenticator.authenticate(request);
      if (
        authInfo === undefined ||
        resolveHttpPrincipal(policy, authInfo) === undefined
      ) {
        return unauthorizedResponse();
      }
      return handler.fetch(request, { authInfo });
    },
  };
}

export function startMailHttpServer({
  port = parseMailHttpPort(Bun.env.PORT),
  ...handlerOptions
}: StartMailHttpServerOptions) {
  const handler = createMailHttpHandler(handlerOptions);
  return Bun.serve({
    fetch: handler.fetch,
    hostname: MAIL_HTTP_HOST,
    port: parseMailHttpPort(String(port)),
  });
}

async function startConfiguredServer(): Promise<void> {
  const policy = await loadAccessPolicy(Bun.env.ICLOUD_MCP_POLICY_PATH, {
    transport: 'http',
  });
  const audit = new LocalAuditLog({
    ...(Bun.env.ICLOUD_MCP_AUDIT_DIR === undefined
      ? {}
      : { directory: Bun.env.ICLOUD_MCP_AUDIT_DIR }),
  });
  startMailHttpServer({ adapter: new AppleMailAdapter(), audit, policy });
}

if (import.meta.main) {
  try {
    await startConfiguredServer();
  } catch {
    console.error('Unable to start the local MCP HTTP server.');
    process.exitCode = 1;
  }
}
