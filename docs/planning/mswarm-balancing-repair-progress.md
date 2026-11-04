# Shared balancing repair progress

- Confirmed both nodes online; Codali pinned Raijin and omitted pooled aliases from discovery.
- Added Codali product grant to Suku; preserved all other grants and running jobs.
- Actual owner alias includes two nodes. Live balanced invocation shi_772b8698ccc8491aa46fb5d70de0f36e executed on Raijin, 22 total tokens, BALANCE_OK.
- Docdex delegation receipts 04e66b67, e6623e28 (invalid invented URL rejected), ee3e45ab (correct retry) use required Qwen balancer.
- Implementing shared native transport consensus, preview product propagation, stable model-name auto routing and Codali discovery. User explicitly requests automatic defaults without pool-hash configuration.
- Core 64 tests passed; gateway 31 passed; proxy initially 76 passed, expanded suite found a trusted-route provenance regression to correct; Codali focused 33 passed.
- Docdex AST/symbols available, impact graphs empty; manually reviewed catalog, scheduler and inference callers. No npm publication.

## Completed production verification

- Shared execution discovery, scheduling and reservation admission now use authenticated owner/tenant scope across registration keys. Node administration and request receipts retain key scoping. Unrelated owners still need explicit grants.
- Ordinary OpenAI requests accept the stable model name; explicit physical slugs and existing hashed aliases remain usable. Native reasoning support is advertised only by all-member consensus.
- Final regression totals: core 67, scheduler 16, proxy 85, gateway 32; TypeScript clean. Codali full suite: 2002 passed, six skipped, zero failures.
- Production six-case check: six successful BALANCE_OK responses, three Raijin and three Suku. Each used 25 tokens, measured 1.105–2.065 seconds. These are routing smoke checks, not intelligence benchmarks or a 50/50 policy guarantee.
- Real Docdex delegation receipt 780aba68-dd58-48c0-ad09-be854628a697 returned DOCDEX_BALANCER_OK through required stable Qwen agent. Local enforcement enabled; primary fallback disabled; cloud delegation disabled.
- Codali installed provider updated; lead/intent catalogId now qwen-latest-flash-next. Configured lead resolves owner pool fcbd290aa1d1 with both physical nodes. Config/provider backups retained locally.
- Shared gateway/proxy files and local deployment image tags updated; both health checks pass. Node processes were not restarted. Protected deployment backups: ~/.local/state/mswarm-balancing-repair-20261104. No npm publication.
- Operations dashboard reports historical failure-count alerts from retained node history; this is separate from the passing current routing checks. Earlier catalog/preview findings were corrected after inspecting opt-in catalog flags and product/owner scope.
