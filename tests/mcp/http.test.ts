import { afterEach, describe, expect, test } from 'bun:test';
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { createServer } from 'node:net';

import {
  createMailHttpHandler,
  MAIL_HTTP_DEFAULT_PORT,
  MAIL_HTTP_HOST,
  MAIL_HTTP_PATH,
  parseMailHttpPort,
} from '../../src/transports/http';
import { FakeMailAdapter } from './fakes';

const openHandlers: { close(): Promise<void> }[] = [];
const openServers: Bun.Server<unknown>[] = [];

async function ephemeralLoopbackPort(): Promise<number> {
  const reservation = createServer();
  return new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, MAIL_HTTP_HOST, () => {
      const address = reservation.address();
      if (address === null || typeof address === 'string') {
        reservation.close();
        reject(new Error('Unable to reserve an ephemeral loopback port.'));
        return;
      }
      reservation.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.stop(true);
  }
  for (const handler of openHandlers.splice(0)) {
    await handler.close();
  }
});

function inProcessFetch(
  handler: ReturnType<typeof createMailHttpHandler>,
): FetchLike {
  return async (input, init) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    const headers = new Headers(request.headers);
    headers.set('host', MAIL_HTTP_HOST);
    return handler.fetch(new Request(request, { headers }));
  };
}

async function verifyEra(
  mode: 'legacy' | 'modern',
  fetchImplementation: FetchLike,
): Promise<void> {
  const client = new Client(
    { name: `http-${mode}`, version: '1.0.0' },
    mode === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : undefined,
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${MAIL_HTTP_HOST}${MAIL_HTTP_PATH}`),
    { fetch: fetchImplementation },
  );
  await client.connect(transport);
  try {
    expect(client.getProtocolEra()).toBe(mode);
    expect((await client.listTools()).tools).toHaveLength(4);
    expect(
      (
        await client.callTool({
          arguments: { limit: 1 },
          name: 'list_folders',
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
  }
}

describe('Streamable HTTP transport', () => {
  test('serves documented legacy and modern protocol eras in process', async () => {
    const handler = createMailHttpHandler({
      adapter: new FakeMailAdapter(),
      diagnostics: () => undefined,
    });
    openHandlers.push(handler);
    const fetchImplementation = inProcessFetch(handler);

    await verifyEra('legacy', fetchImplementation);
    await verifyEra('modern', fetchImplementation);
  });

  test('rejects hostile Hosts and routes other than /mcp', async () => {
    const handler = createMailHttpHandler({
      adapter: new FakeMailAdapter(),
      diagnostics: () => undefined,
    });
    openHandlers.push(handler);
    const hostile = await handler.fetch(
      new Request(`http://${MAIL_HTTP_HOST}${MAIL_HTTP_PATH}`, {
        headers: { host: 'attacker.example' },
      }),
    );
    const wrongPath = await handler.fetch(
      new Request(`http://${MAIL_HTTP_HOST}/other`, {
        headers: { host: MAIL_HTTP_HOST },
      }),
    );

    expect(hostile.status).toBe(403);
    expect(wrongPath.status).toBe(404);
    expect(hostile.headers.has('access-control-allow-origin')).toBe(false);
    expect(wrongPath.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('completes a bounded loopback smoke on an ephemeral port', async () => {
    const handler = createMailHttpHandler({
      adapter: new FakeMailAdapter(),
      diagnostics: () => undefined,
    });
    openHandlers.push(handler);
    const port = await ephemeralLoopbackPort();
    const server = Bun.serve({
      fetch: handler.fetch,
      hostname: MAIL_HTTP_HOST,
      port,
    });
    openServers.push(server);
    const client = new Client(
      { name: 'loopback-smoke', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${MAIL_HTTP_HOST}:${server.port}${MAIL_HTTP_PATH}`),
    );

    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect((await client.listTools()).tools).toHaveLength(4);
    } finally {
      await client.close();
    }
    expect(
      (await fetch(`http://${MAIL_HTTP_HOST}:${server.port}/not-mcp`)).status,
    ).toBe(404);
  });

  test('validates the configurable local port', () => {
    expect(parseMailHttpPort(undefined)).toBe(MAIL_HTTP_DEFAULT_PORT);
    expect(parseMailHttpPort('1')).toBe(1);
    expect(parseMailHttpPort('65535')).toBe(65_535);
    for (const value of ['', '0', '65536', '-1', '3000.5', ' 3000']) {
      expect(() => parseMailHttpPort(value)).toThrow(
        'Invalid local MCP HTTP port.',
      );
    }
  });
});
