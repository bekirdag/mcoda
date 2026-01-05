# mcoda

mcoda is a local-first CLI for planning, documentation, and execution workflows with agent assistance.

## Install
- Requires Node.js >= 20.
- Global install: `npm i -g mcoda`
- Verify: `mcoda --version`

## Quick start
```sh
mcoda set-workspace --workspace-root .
mcoda docs pdr generate --workspace-root . --project WEB --rfp-path docs/rfp/web.md --agent codex
```

## Documentation
Full docs live in the repository:
- README: https://github.com/bekirdag/mcoda
- Usage guide: https://github.com/bekirdag/mcoda/blob/main/docs/usage.md
- Quality gates: https://github.com/bekirdag/mcoda/blob/main/docs/quality_gates.md

## License
MIT - see `LICENSE`.
