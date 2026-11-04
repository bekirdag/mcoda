# Codali prerelease 27 progress

Prepared 2026-11-04 from 841e732 with latest responsive wordmark and terminal/model recovery changes. npm .27 is unused; next currently .18.

One registered runner: sukunahikona-ci-mcoda, online Linux X64 wodo-ci. Linux package jobs already self-hosted; exact-artifact Linux checks now use it too. Final publisher remains hosted because npm trusted publishing/provenance does not support self-hosted runners. NPM_TOKEN repository secret exists; no credentials exposed.

Docdex impact for workflow returned no edges (YAML dependency coverage limited); reviewed package → qualification → publication ordering directly. Local delegation receipt 0b45b3ae-2677-4cca-821b-23771100f852 via openai-api qwen-latest-flash-next produced runner expression after invalid first draft was rejected.

Pending: release qualification, publication, registry verification.
