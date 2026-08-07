# iCloud MCP

An open-source project for a local iCloud Mail MCP integration.

The repository currently contains only contribution and quality foundations. Product implementation, Apple Mail access, MCP transports, authentication, tunnels, and remote connectivity are intentionally deferred to separately scoped work.

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
