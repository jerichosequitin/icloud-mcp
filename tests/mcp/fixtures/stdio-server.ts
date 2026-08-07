import { loadAccessPolicy, resolveStdioPrincipal } from '../../../src/access';
import { LocalAuditLog } from '../../../src/audit';
import { startMailStdio } from '../../../src/transports/stdio';
import { FakeMailAdapter } from '../fakes';

try {
  const policy = await loadAccessPolicy(Bun.env.ICLOUD_MCP_POLICY_PATH, {
    transport: 'stdio',
  });
  const principal = resolveStdioPrincipal(policy, Bun.env.ICLOUD_MCP_CLIENT_ID);
  const audit = new LocalAuditLog({
    ...(Bun.env.ICLOUD_MCP_AUDIT_DIR === undefined
      ? {}
      : { directory: Bun.env.ICLOUD_MCP_AUDIT_DIR }),
  });
  startMailStdio({
    adapter: new FakeMailAdapter(),
    audit,
    diagnostics: () => console.error('Synthetic stdio transport error.'),
    principal,
  });
} catch {
  console.error('Unable to start the local MCP stdio server.');
  process.exitCode = 1;
}
