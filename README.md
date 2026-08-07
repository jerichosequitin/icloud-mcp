# iCloud MCP

An open-source project for a local iCloud Mail MCP integration.

The current implementation includes a local, read-only Apple Mail adapter and four typed MCP tools exposed over stdio and loopback-only Streamable HTTP. Authentication, tunnels, and remote connectivity remain deferred to separately scoped work.

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

Run the local stdio server with:

```sh
bun run mcp:stdio
```

Run the Streamable HTTP server with:

```sh
bun run mcp:http
```

The HTTP endpoint is exactly `http://127.0.0.1:3000/mcp`. Set a different local port with `PORT`, for example:

```sh
PORT=3100 bun run mcp:http
```

HTTP always binds to `127.0.0.1`, accepts only loopback or `localhost` Host headers, and does not enable permissive CORS. Both transports support the MCP 2025 legacy era and the 2026-07-28 modern era through the official stable TypeScript SDK compatibility entry points.

The HTTP transport is intentionally unauthenticated and unreachable from non-loopback interfaces in this issue. Do not expose it through a tunnel, proxy, DNS record, or public listener. Authentication and remote access remain out of scope until JER-110.

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
