# iCloud MCP

An open-source project for a local iCloud Mail MCP integration.

The current implementation includes a local, read-only Apple Mail adapter and four typed MCP tools exposed over authenticated stdio and loopback-only Streamable HTTP. Every client has an explicit tool and Mail-folder policy, and every allowed adapter call or authorization denial is written to a local audit log.

## Read-only Mail adapter

`src/mail/index.ts` exports a typed adapter with exactly four operations:

- `listFolders` returns concise account and mailbox names with opaque folder locators;
- `searchMail` searches one selected folder by subject, sender, or recipient and returns concise metadata;
- `getMessageMetadata` returns headers and Mail status for explicitly selected message locators;
- `getMessageBodies` returns body content only for explicitly selected message locators.

Searches scan at most 500 messages and return at most 50 results. Folder, metadata, body, query, output-size, and execution-time limits are also enforced by the adapter. Missing Apple Mail fields are represented as `null`, while missing message locators are returned separately from successful results.

The adapter selects fixed AppleScript source for each operation, invokes `/usr/bin/osascript` directly without a shell, and passes all caller input through `on run argv`. It exposes no Mail write operation and does not accept script source, script paths, shell fragments, or raw AppleScript predicates. Tests use a fake runner and synthetic data; no personal Mail data is stored or emitted by the test suite.

## MCP tools and transports

The server discovers exactly four read-only tools:

- `list_folders`
- `search_mail`
- `get_message_metadata`
- `get_message_bodies`

Only `get_message_bodies` returns message body content. Every successful call returns the validated structured result plus one JSON text block containing the same result for compatibility.

## Access policy

Set `ICLOUD_MCP_POLICY_PATH` to an absolute path for a versioned JSON policy stored outside this repository. The policy file and its parent directory must be owned by the current user; the file must have no group or world permissions, and the parent directory must not be group- or world-writable. The server refuses to start for a missing, relative, repository-local, malformed, or insecure policy. Copy [policy.example.json](policy.example.json) to a private configuration directory, set the file mode to `0600`, and replace the synthetic IDs and locators.

Each client entry requires:

- a stable `id`;
- exactly one `transport`, either `stdio` or `http`;
- an exact subset of the four read-only tools;
- `mailScope` set explicitly to `"*"` or an allowlist of opaque folder locators;
- an explicit `allowBodies` boolean;
- for HTTP only, a `bearerTokenEnv` naming an environment variable that contains the token at launch.

Token values never belong in the policy. Unknown keys, duplicate client IDs, duplicate tools or locators, unknown tools, invalid locators, HTTP token environment variables missing at HTTP startup, and transport-specific field mismatches all fail startup. Stdio startup does not resolve unused HTTP secrets from a shared policy. Account IDs and every mailbox-path segment are compared exactly and case-sensitively. Account display names, MCP client metadata, headers other than `Authorization`, and arbitrary request metadata never establish identity.

`get_message_bodies` requires both tool permission and `allowBodies: true`. Folder listing is filtered to authorized locators before the requested limit is applied. Search is authorized before execution, and metadata or body batches containing any denied locator are rejected atomically.

Run the local stdio server with:

```sh
ICLOUD_MCP_POLICY_PATH=/absolute/private/policy.json \
ICLOUD_MCP_CLIENT_ID=local-desktop-client \
bun run mcp:stdio
```

Stdio identity comes only from `ICLOUD_MCP_CLIENT_ID`. A missing, unknown, or HTTP-only client ID fails startup. The name and version reported by the MCP client are treated only as optional untrusted audit metadata.

Run the Streamable HTTP server with:

```sh
ICLOUD_MCP_POLICY_PATH=/absolute/private/policy.json \
ICLOUD_MCP_EXAMPLE_HTTP_TOKEN='replace-with-a-random-secret' \
bun run mcp:http
```

The HTTP endpoint is exactly `http://127.0.0.1:3000/mcp` and every request requires `Authorization: Bearer <token>`. The token is compared in constant time and maps to the configured HTTP client ID before MCP dispatch. Missing, malformed, or invalid authentication receives a fixed `401` with a Bearer challenge. Set a different local port with `PORT`, for example:

```sh
PORT=3100 bun run mcp:http
```

HTTP always binds to `127.0.0.1`, accepts only loopback or `localhost` Host headers, and does not enable permissive CORS. Both transports support the MCP 2025 legacy era and the 2026-07-28 modern era through the official stable TypeScript SDK compatibility entry points.

Do not expose the HTTP server through a tunnel, proxy, DNS record, or public listener. OAuth and remote connector configuration remain separately scoped work.

## Local audit log

Audit entries are JSON Lines in `~/Library/Logs/icloud-mcp` by default. Set `ICLOUD_MCP_AUDIT_DIR` to a non-empty absolute path to use another local directory. Files roll over at UTC midnight as `audit-YYYY-MM-DD.jsonl`; the directory is mode `0700`, files are mode `0600`, and the latest 30 daily files are retained.

Each record contains only a schema version, UTC timestamp, random event ID, authenticated client ID, transport, tool, allow or deny decision, fixed reason code, and protocol era. Untrusted MCP client metadata is omitted. Audit entries never contain bearer tokens, headers, policy scopes, queries, locators, Mail identifiers or content, adapter output, stack traces, or raw errors. If an allow record cannot be durably appended, the adapter is not invoked.

## Requirements

- [Bun](https://bun.sh/) 1.3.14

Install dependencies with:

```sh
bun install --frozen-lockfile
```

## Quality checks

Run the full local quality suite before opening a pull request:

```sh
bun run quality
```

The suite checks formatting, lint rules, TypeScript types, and tests. Individual commands are also available:

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
```

GitHub Actions runs the same suite for every pull request and every push to `master`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions and the pull request process.

## Security

Do not report vulnerabilities in public issues. Follow the private reporting process in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
