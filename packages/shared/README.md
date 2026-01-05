# @mcoda/shared

Shared utilities and schemas used across the mcoda workspace.

## Install
- Requires Node.js >= 20.
- Install: `npm i @mcoda/shared`

## What it provides
- PathHelper for resolving mcoda directories.
- CryptoHelper for local secret encryption.
- CommandMetadata helpers and OpenAPI types.
- QA profile types.

## Example
```ts
import { PathHelper } from "@mcoda/shared";

await PathHelper.ensureDir(PathHelper.getGlobalMcodaDir());
```

## Notes
- Intended for use by other mcoda packages; APIs may evolve.

## License
MIT - see `LICENSE`.
