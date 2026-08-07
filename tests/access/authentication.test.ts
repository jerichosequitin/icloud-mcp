import { describe, expect, test } from 'bun:test';

import {
  createLocalBearerAuthenticator,
  resolveHttpPrincipal,
  resolveStdioPrincipal,
} from '../../src/access';
import { TEST_HTTP_CLIENT, TEST_HTTP_TOKEN, TEST_POLICY } from '../mcp/fakes';

describe('client authentication and identity', () => {
  test('authenticates only exact Bearer tokens and maps them to one client', async () => {
    const authenticator = createLocalBearerAuthenticator(TEST_POLICY);
    const request = (authorization?: string) =>
      new Request('http://127.0.0.1/mcp', {
        headers: authorization === undefined ? {} : { authorization },
      });

    for (const value of [
      undefined,
      '',
      `Basic ${TEST_HTTP_TOKEN}`,
      'Bearer',
      'Bearer wrong-token',
      `Bearer ${TEST_HTTP_TOKEN} extra`,
    ]) {
      expect(await authenticator.authenticate(request(value))).toBeUndefined();
    }

    const authInfo = await authenticator.authenticate(
      request(`Bearer ${TEST_HTTP_TOKEN}`),
    );
    expect(authInfo?.clientId).toBe(TEST_HTTP_CLIENT.id);
    expect(resolveHttpPrincipal(TEST_POLICY, authInfo!)).toMatchObject({
      client: { id: TEST_HTTP_CLIENT.id },
      transport: 'http',
    });
  });

  test('requires an explicit known stdio identity with matching transport', () => {
    expect(() => resolveStdioPrincipal(TEST_POLICY, undefined)).toThrow(
      'Invalid iCloud MCP client identity.',
    );
    expect(() => resolveStdioPrincipal(TEST_POLICY, 'unknown')).toThrow(
      'Invalid iCloud MCP client identity.',
    );
    expect(() =>
      resolveStdioPrincipal(TEST_POLICY, TEST_HTTP_CLIENT.id),
    ).toThrow('Invalid iCloud MCP client identity.');
    expect(resolveStdioPrincipal(TEST_POLICY, 'test-stdio')).toMatchObject({
      client: { id: 'test-stdio' },
      transport: 'stdio',
    });
  });
});
