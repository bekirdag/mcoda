# Codali Storage Contract v1

Canonical TypeScript contracts and validators live in
`packages/codali/src/storage/CodaliStorageContracts.ts` and are exported from
`@mcoda/codali`.

External payload fixtures in this directory use snake_case. Validators normalize
them to camelCase internal structures and require explicit schema versions plus
privacy allow flags for upload, export, and training.

`codali-storage-service` consumes this contract from the published package surface
instead of copying contract code. Its Phase 1 verifier imports the built
`@mcoda/codali` package and validates this fixture set unchanged.

## Feedback And Review Adapter Guidance

Feedback and human-review submissions must carry run id, deletion group, product
scope, requester scope, and candidate record references. Product adapters should
default requester-sourced chat feedback to per-requester or per-conversation
visibility, with `tenant_wide` false, unless a separate product policy explicitly
approves tenant-wide use.

Employee-chat or requester-scoped product adapters must use per-requester scope
by default: submit a requester hash and conversation hash when available, keep
`tenant_wide` false, and only promote reviewed labels or candidate record ids
into datasets. Do not submit raw trace payloads for review-driven dataset
promotion unless privacy metadata and policy explicitly permit it.

OKACAM adapters should follow the same product-neutral contract by storing the
assistant-message `feedback_submission` or `codali_product_metadata.feedback_ref`
per employee/user scope; no OKACAM-specific fields are required in core Codali or
mswarm payloads.
