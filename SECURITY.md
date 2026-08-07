# Security Policy

## Supported versions

Security fixes are applied to the latest code on `master`. No released versions are currently supported.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/jerichosequitin/icloud-mcp/security/advisories/new).

Include only the information needed to reproduce and assess the issue. Remove credentials, message contents, personal data, and unrelated logs before submitting a report.

Do not disclose the vulnerability in a public issue, discussion, or pull request. The maintainer will acknowledge the report, investigate its impact, and coordinate remediation and disclosure through the private advisory.

## Deployment boundary

This server is designed to keep AppleScript execution and Apple Mail data on the local Mac. The HTTP transport binds only to `127.0.0.1`, validates loopback Host headers, requires a configured Bearer token, and does not enable permissive CORS. Do not place it behind a tunnel, public proxy, public DNS route, or non-loopback listener.

Store the access policy outside the repository with appropriate local permissions. Put only bearer-token environment variable names in the policy, never token values. Do not commit policies, tokens, audit files, Mail locators, account identifiers, folder names, message metadata, or message bodies.

Audit logs identify authenticated clients and allowed or denied tool access without recording Mail data or credentials. Protect and rotate the local audit directory as sensitive operational metadata even though Mail content is excluded.
