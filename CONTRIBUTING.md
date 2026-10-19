# Contributing

Use Node 22 and the pnpm version pinned in `package.json` (Corepack).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

For changes to mail behavior, run `pnpm e2e` against an isolated GreenMail
container; setup is documented at the top of `apps/node/scripts/e2e.mjs`.
Never run that suite against a real mailbox: it sends and moves test mail.

Open a pull request with the problem, change and verification. Keep both Node
and Worker behavior consistent, or document any runtime limitation. Never add
credentials, mailbox exports, or personal email content to commits or issues.

CI validates tests, both runtimes' types, the Node build, GreenMail E2E and Docker
build before publishing. Release instructions: [docs/releases.md](docs/releases.md).
