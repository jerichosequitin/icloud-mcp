import {
  createMcpHandler,
  hostHeaderValidationResponse,
} from '@modelcontextprotocol/server';

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
  diagnostics?: (message: string) => void;
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
  diagnostics = (message) => console.error(message),
}: CreateMailHttpHandlerOptions): MailHttpHandler {
  const handler = createMcpHandler(() => createMailMcpServer({ adapter }), {
    legacy: 'stateless',
    onerror: () => diagnostics('MCP HTTP transport error.'),
    responseMode: 'auto',
  });
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
      return handler.fetch(request);
    },
  };
}

export function startMailHttpServer(
  adapter: MailMcpAdapter,
  port = parseMailHttpPort(Bun.env.PORT),
) {
  const handler = createMailHttpHandler({ adapter });
  return Bun.serve({
    fetch: handler.fetch,
    hostname: MAIL_HTTP_HOST,
    port: parseMailHttpPort(String(port)),
  });
}

if (import.meta.main) {
  try {
    startMailHttpServer(new AppleMailAdapter());
  } catch {
    console.error('Unable to start the local MCP HTTP server.');
    process.exitCode = 1;
  }
}
