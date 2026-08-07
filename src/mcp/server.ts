import { Server } from '@modelcontextprotocol/server';

import type { AuthenticatedPrincipal, ProtocolEra } from '../access';
import type { AuditLog } from '../audit';
import { registerMailTools, type MailMcpAdapter } from './tools';

export interface CreateMailMcpServerOptions {
  adapter: MailMcpAdapter;
  audit: AuditLog;
  principal: AuthenticatedPrincipal;
  protocolEra: ProtocolEra;
}

export function createMailMcpServer({
  adapter,
  audit,
  principal,
  protocolEra,
}: CreateMailMcpServerOptions): Server {
  const server = new Server(
    { name: 'icloud-mail', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerMailTools(server, { adapter, audit, principal, protocolEra });
  return server;
}
