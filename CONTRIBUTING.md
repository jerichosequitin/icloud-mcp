# Contributing

Thank you for contributing to iCloud MCP.

## Scope

Keep each change focused on one issue. Product behavior, Apple app access, MCP transports, authentication, tunnels, and remote connectivity require their own explicitly scoped work.

Before starting a larger change, open an issue so its behavior and boundaries can be agreed on first.

## Development setup

1. Install Bun 1.3.14.
2. Install dependencies with `bun install --frozen-lockfile`.
3. Create a focused branch from the latest `master`.
4. Make the smallest change that satisfies the issue.

## Conventions

- Use TypeScript for project code unless an issue explicitly requires otherwise.
- Use two spaces for indentation.
- Use single quotes in JavaScript and TypeScript.
- Include trailing commas in multiline arrays and objects.
- Keep functions focused and prefer clear names over explanatory comments.
- Do not commit credentials, local environment files, session data, or generated coverage.
- Add or update tests for behavior changes.
- Keep product architecture decisions out of foundation-only changes.

Prettier and ESLint are the source of truth when written conventions are incomplete.

## Quality checks

Run the same suite used by CI:

```sh
bun run quality
```

To apply formatting before rerunning the suite:

```sh
bun run format
```

## Commits and pull requests

Use focused commits with Conventional Commit subjects, for example:

```text
test: cover mailbox name parsing
```

Pull requests should:

- link the relevant issue;
- explain the user or contributor impact;
- identify important scope boundaries;
- include validation results;
- avoid unrelated refactors or generated artifacts.

All CI checks must pass before merge. Review feedback should be addressed in additional commits so the review history remains inspectable.

## Security reports

Follow [SECURITY.md](SECURITY.md). Do not include vulnerability details, credentials, private logs, or personal data in a public issue or pull request.
