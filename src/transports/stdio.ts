import { serveStdio } from '@modelcontextprotocol/server/stdio';

import {
  loadAccessPolicy,
  resolveStdioPrincipal,
  type AuthenticatedPrincipal,
} from '../access';
import { LocalAuditLog, type AuditLog } from '../audit';
import { AppleMailAdapter } from '../mail/adapter';
import { createMailMcpServer } from '../mcp/server';
import type { MailMcpAdapter } from '../mcp/tools';

interface StartMailStdioOptions {
  adapter: MailMcpAdapter;
  audit: AuditLog;
  diagnostics?: (message: string) => void;
  principal: AuthenticatedPrincipal;
}

export function startMailStdio({
  adapter,
  audit,
  diagnostics = (message) => console.error(message),
  principal,
}: StartMailStdioOptions) {
  if (principal.transport !== 'stdio') {
    throw new Error('Invalid iCloud MCP client identity.');
  }
  return serveStdio(
    ({ era }) =>
      createMailMcpServer({
        adapter,
        audit,
        diagnostics,
        principal,
        protocolEra: era,
      }),
    {
      legacy: 'serve',
      onerror: () => diagnostics('MCP stdio transport error.'),
    },
  );
}

async function startConfiguredServer(): Promise<void> {
  const policy = await loadAccessPolicy(Bun.env.ICLOUD_MCP_POLICY_PATH, {
    transport: 'stdio',
  });
  const principal = resolveStdioPrincipal(policy, Bun.env.ICLOUD_MCP_CLIENT_ID);
  const audit = new LocalAuditLog({
    ...(Bun.env.ICLOUD_MCP_AUDIT_DIR === undefined
      ? {}
      : { directory: Bun.env.ICLOUD_MCP_AUDIT_DIR }),
  });
  startMailStdio({ adapter: new AppleMailAdapter(), audit, principal });
}

if (import.meta.main) {
  try {
    await startConfiguredServer();
  } catch {
    console.error('Unable to start the local MCP stdio server.');
    process.exitCode = 1;
  }
}
