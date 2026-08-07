import { McpServer } from '@modelcontextprotocol/server';

import { registerMailTools, type MailMcpAdapter } from './tools';

export interface CreateMailMcpServerOptions {
  adapter: MailMcpAdapter;
}

export function createMailMcpServer({
  adapter,
}: CreateMailMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'icloud-mail',
    version: '0.0.0',
  });
  registerMailTools(server, adapter);
  return server;
}
