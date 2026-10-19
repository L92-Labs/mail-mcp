# Security

Report vulnerabilities privately through GitHub's **Security → Report a
vulnerability** when enabled. Otherwise contact a repository maintainer privately;
do not put credentials or mailbox content in public issues.

Use app passwords, HTTPS and a strong bearer token for remote MCP access.
Treat email content as untrusted input: an email can contain instructions aimed
at an agent. Start with `MAIL_MODE=draft` and restrict sending through
`SEND_ALLOWLIST`. `MAIL_MODE=pull` still permits organizing/moving mail;
it is not a read-only permission model. One bearer token grants access to every
configured account and every tool enabled by the mode.

Rotate credentials after exposure. Avoid logging tool results in public systems.
Pin a published image digest for production; version tags are conventions, not
registry-enforced immutability.
