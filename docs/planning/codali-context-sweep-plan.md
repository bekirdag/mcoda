# Qwen context qualification

Test context windows 8192, 16384, 32768, 65536, 131072 and 262144 (GGUF declared maximum) independently on Raijin and Suku. Refine around the best feasible capacity if evidence justifies it. Keep output capped independently; test output budgets on a selected feasible context.

Drain one mswarm node at a time after verifying SIGUSR2 support. Preserve profiles and restore on failure. Keep the other host serving. Record health, actual engine context, available RAM/GPU memory, cache capacity, errors and latency. Do not kill unrelated workloads or exceed the model's declared limit.

Use identical short correctness tasks, tool protocol checks, code completion/review and deterministic long-context retrieval with planted evidence near beginning/middle/end. Measure real usage, exact-answer correctness and wall time; include shared-length tasks across windows and near-capacity tests for capability. Repeat finalists to avoid choosing from a single noisy result. Larger windows alone are not proof of greater intelligence.

Choose a per-host setting prioritizing correctness and stability, then time/memory cost. Reject failed/unsafe settings, retain raw results and explicitly state untested outcomes. Apply the measured winner, restore mswarm admission and verify advertised capacity. No npm publication.
