# Codali prerelease 27 progress

Prepared 2026-11-04 from 841e732 with latest responsive wordmark and terminal/model recovery changes. npm .27 is unused; next currently .18.

One registered runner: sukunahikona-ci-mcoda, online Linux X64 wodo-ci. Linux package jobs already self-hosted; exact-artifact Linux checks now use it too. Final publisher remains hosted because npm trusted publishing/provenance does not support self-hosted runners. NPM_TOKEN repository secret exists; no credentials exposed.

Docdex impact for workflow returned no edges (YAML dependency coverage limited); reviewed package → qualification → publication ordering directly. Local delegation receipt 0b45b3ae-2677-4cca-821b-23771100f852 via openai-api qwen-latest-flash-next produced runner expression after invalid first draft was rejected.

Pending: release qualification, publication, registry verification.

Release validation: 19 publisher/packer tests passed through Docdex test runner; semantic pre-commit hook and diff checks passed. Release tag v0.1.135-codali.27 points to 6f3582237aa4b91341b591b475794de24747f4d3. GitHub release run: https://github.com/bekirdag/mcoda/actions/runs/41821760167. Linux packaging confirmed executing on sukunahikona-ci-mcoda. Publication remains pending.

.27 publication blocked by Apple Silicon package tests: nine failures due to missing Python math/document runtimes, plus default-interpreter sandbox failure. Release packaging omitted setup present in successful platform qualification. Added Python 3.12 and pinned runtime installers before non-Windows package tests; preserving all assertions. Superseding unpublished .27 with .28 without moving tags. Local .27 exact-artifact installation passed.
