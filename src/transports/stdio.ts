import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { AppleMailAdapter } from '../mail/adapter';
import { createMailMcpServer } from '../mcp/server';
import type { MailMcpAdapter } from '../mcp/tools';

interface StartMailStdioOptions {
  adapter: MailMcpAdapter;
  diagnostics?: (message: string) => void;
}

export function startMailStdio({
  adapter,
  diagnostics = (message) => console.error(message),
}: StartMailStdioOptions) {
  return serveStdio(() => createMailMcpServer({ adapter }), {
    legacy: 'serve',
    onerror: () => diagnostics('MCP stdio transport error.'),
  });
}

if (import.meta.main) {
  startMailStdio({ adapter: new AppleMailAdapter() });
}
