# ChatGPT Web through Secure MCP Tunnel

This profile connects ChatGPT Web to the existing stdio server through OpenAI Secure MCP Tunnel. The tunnel client initiates outbound HTTPS to OpenAI and starts the server locally over stdio. The Mail MCP stays private: it has no public listener, inbound firewall rule, DNS record, or public proxy.

Use the current OpenAI [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for tunnel-client installation, Platform permissions, and ChatGPT availability. OpenAI Platform and ChatGPT workspace operations are deliberately outside this repository setup.

## Access contract

The ChatGPT runtime identity is exactly `chatgpt-web`. It comes only from `ICLOUD_MCP_CLIENT_ID`, not from ChatGPT metadata or tunnel configuration.

The example policy grants one stdio client only:

- `list_folders`
- `search_mail`
- `get_message_metadata`

It denies message bodies by omitting `get_message_bodies` and setting `allowBodies` to `false`. Its folder locator is synthetic. Before launch, copy the policy outside the repository and replace that locator with only the explicitly approved Mail folder locators. Do not use `"*"` unless broad Mail-folder access receives separate approval.

No Calendar, Reminders, Mail write, arbitrary AppleScript, HTTP transport, Bearer credential, or OAuth capability is part of this profile. Existing policy enforcement and local audit behavior remain unchanged.

## Prepare the external policy

From the repository root, create a private configuration directory and copy the synthetic example:

```sh
install -d -m 700 /absolute/private/icloud-mcp
install -m 600 \
  examples/policies/chatgpt-web.example.json \
  /absolute/private/icloud-mcp/chatgpt-web.policy.json
```

Edit only the external copy. Replace the synthetic folder locator with the approved real locator or locators, keep the file mode at `0600`, and keep its parent directory unavailable for group or world writes. The server rejects a repository-local, relative, insecure, or malformed policy path.

## Create the stdio profile

Obtain `tunnel-client` from the current official OpenAI release referenced by the Secure MCP Tunnel guide. Inject `CONTROL_PLANE_API_KEY` from the operator's local secret manager into the tunnel-client process; do not place its value in the policy, profile command, shell history, repository, logs, or support artifacts.

Create a named stdio profile with the real tunnel ID supplied at runtime:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile chatgpt-web \
  --tunnel-id '<tunnel-id>' \
  --mcp-command "/usr/bin/env ICLOUD_MCP_POLICY_PATH=/absolute/private/icloud-mcp/chatgpt-web.policy.json ICLOUD_MCP_CLIENT_ID=chatgpt-web bun --cwd=/absolute/path/to/icloud-mcp run mcp:stdio"
```

The `--mcp-command` must keep `ICLOUD_MCP_CLIENT_ID=chatgpt-web` and must reference the external policy. It intentionally launches `mcp:stdio`; do not substitute `mcp:http` or expose the loopback HTTP transport through the tunnel.

Validate and run the profile only after the runtime secret is present in the process environment:

```sh
tunnel-client doctor --profile chatgpt-web --explain
tunnel-client run --profile chatgpt-web
```

Keep the tunnel client inside the same private trust boundary as this repository checkout. Its required network path is outbound HTTPS to OpenAI plus the local stdio child process. No inbound route to the Mail MCP is required.

## Connect and verify in ChatGPT

These steps require external authority and are not performed by repository tests:

1. In OpenAI Platform tunnel settings, associate the tunnel with the intended Platform organization and ChatGPT workspace.
2. Confirm the operator has Tunnels Read + Use and the ChatGPT workspace grants developer-mode access. Tunnel creation or editing additionally requires Tunnels Read + Manage.
3. In ChatGPT Web, create a developer-mode app, choose `Tunnel` as the connection, select the associated tunnel, and scan tools.
4. Confirm the scan exposes exactly `list_folders`, `search_mail`, and `get_message_metadata`. It must not expose `get_message_bodies` or any Calendar, Reminders, Mail write, or arbitrary execution tool.
5. After an authorized read-only test call, inspect the local audit file privately. Confirm the record identifies client `chatgpt-web`, transport `stdio`, the invoked approved tool, and the allow or deny decision. Do not paste audit records into issues, pull requests, or support artifacts.

ChatGPT and tunnel-client availability cannot prove the policy boundary by themselves. The external policy is the repository-enforced source of truth, and changing ChatGPT's published tool snapshot requires the workspace's normal review or republish process.

## Repository-only validation

The connector contract test reads this guide and the synthetic example directly. It requires no network, tunnel, ChatGPT workspace, API key, audit record, or Mail access:

```sh
bun test tests/connectors/chatgpt-secure-tunnel.test.ts
```

Actual tunnel creation, organization or workspace association, ChatGPT app creation, and live Mail verification remain operational blockers until an authorized operator completes them outside this repository task.
