# Fresh complex-work benchmark — 50 tasks + two web applications

This prospective study compares the Codali controller against raw Qwen with a native tool loop, using the same `qwen-latest-flash-next` mSwarm pool and qualified Codali runtime `eb1b36f`.

- Fifty new prompts: forty multi-step data, mathematics, code, testing, security, architecture, planning and science tasks; ten deep-web investigations.
- Two new full web-app specifications: **FrostLedger** (cold-chain custody/excursions) and **BenchHarbor** (workshop reservations/maintenance/stock).
- Each arm receives the same public prompt/files, Qwen context/reasoning/output settings, permitted tools and outer budget. Raw has tool discovery, native tool calls, shared Docdex/browser/deterministic implementations and retrievable context compression; it has no Codali planning/review/repair controller.
- Each answer attempt: 120,000 model tokens,20 calls,40 tool calls,10minutes. Each application: 1,000,000 model tokens,100 calls,240 tool calls,60minutes. These are evaluation ceilings, not product limits. Codali's internal stage allocations are part of its behavior.
- Native reasoning requests: low/1024-token reasoning budget for answer tasks; medium/2048 for app builds. Context65536. Maximum outputs4096/8192 respectively.
- First attempts only, alternating order. No source repairs, prompt tuning or reclassification of failures after starting. Retries, if ever required, must be separate results.
- The private scoring corpus and independent application checks are never supplied to either system. API requirements are public; test sequences and expected assertions remain evaluator-side.
- All responses, model/tool events, immutable input hashes and project submissions are retained. Application validation operates on copies.

## Scoring

Each text task has five prospectively written20-point criteria. Each criterion earns0,10or20, with evidence. Research requires actual retrieval, substantive primary sources and supported citations; unsupported plausible prose does not earn evidence points. Show every task, two50-task averages, paired differences, failure counts and domain averages. Report both percentage-point and relative changes.

Each app has a100-point rubric:48feature,14build/delivery,12security,6tests,12UI/UX,8code quality. Missing functionality scores0. A blocked evaluation is labeled unverified, not silently passed. Aesthetic judgments require screenshots. Independent API tests supplement source/browser review, not replace it.

Report token totals and elapsed time for all attempts including failures, not just successes. Show ratios beside quality and completion; do not claim the10% quality /<=1.5x token/time target from a favorable subset. App scores remain separate from text-task scores.

## Limits

Newly authored does not establish that similar ideas were absent from training. Live web results and shared production model load vary. Qwen inference is local to Raijin/Suku through the shared balancer; research accesses public web sources. Client usage includes its model calls, routing and review. Docdex-owned inference is separately identified as unmetered: these model-token totals are not complete system-cost accounting. One run per task has limited statistical precision; subjective rubric judgments must be labeled. No npm publication is part of this study.

## Locations

Public tasks and private evaluator rubrics: `tasks/` and `apps/`. App RFPs: `rfps/`. Local run state: `~/.local/state/codali-complex52-20261105/`. Prospective freeze and final report are added only after the corresponding evidence exists.
