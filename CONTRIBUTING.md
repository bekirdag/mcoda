# Contributing to mcoda

Thanks for your interest in improving mcoda! This guide covers the basics for local setup, testing, and releases.

## Prereqs
- Node.js >= 20
- pnpm (recommended) or npm
- Git

## Setup
```bash
git clone git@github.com:bekirdag/mcoda.git
cd mcoda
pnpm install
pnpm -r run build
pnpm -r run test
```

## Making changes
- Keep versions aligned across published packages (cli, core, db, integrations, shared, agents).
- Add or update docs when behavior or flags change.
- Prefer small, focused PRs with clear commit messages.

## Testing
- Run the full test suite before opening a PR:
  - `pnpm -r run build`
  - `pnpm -r run test`
- If you touch packaging or release logic, run:
  - `pnpm --filter mcoda run pack:verify`

## Releases
- Releases are tagged as `vX.Y.Z` on `main`.
- GitHub Actions runs release workflows and publishes to npm using trusted publishing (OIDC).
- Release-please manages version bumps and changelogs.

## Reporting issues
- Include repro steps, expected/actual behavior, and environment details.
- For security issues, use GitHub Security Advisories instead of filing a public issue.
