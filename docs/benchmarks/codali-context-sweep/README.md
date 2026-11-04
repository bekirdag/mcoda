# Qwen context qualification — 2026-11-04

Selected **65,536 tokens on both Raijin and Sukunahikona**, up from 32,768. This is a conservative operating choice, not a claim of a uniquely optimal context or increased intelligence. It accommodates substantially longer repository/tool conversations without the extra expert-cache displacement of 128K/256K. All six tested sizes loaded and served successfully on both hosts.

## Controlled sweep

Same installed Qwen Flash Next IQ3_S model, int8 KV, one inference slot, existing speculation settings and temperature zero. Only `--max-context` changed. Sizes: 8,192, 16,384, 32,768, 65,536, 131,072 and the model-declared maximum 262,144. This samples useful powers of two; it does not test every integer size or every possible task.

| Context | Near-capacity input tokens | Raijin retrieval seconds | Suku retrieval seconds | Raijin expert cache MiB | Suku expert cache MiB | Raijin structured seconds | Suku structured seconds |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 8,192 | 6,273 | 3.134 | 4.171 | 21,653 | 21,267 | — | 6.325 |
| 16,384 | 12,988 | 6.233 | 7.286 | 21,534 | 21,145 | 5.498 | 6.369 |
| 32,768 | 26,418 | 15.520 | 13.485 | 21,272 | 20,891 | 5.487 | 6.254 |
| **65,536** | **53,295** | **20.708** | **22.844** | **20,776** | **20,400** | **5.485** | **6.329** |
| 131,072 | 107,032 | 41.500 | 44.924 | 19,781 | 19,415 | 5.511 | 6.438 |
| 262,144 | 214,506 | 88.234 | 100.006 | 17,801 | 17,430 | 5.570 | 6.705 |

Retrieval plants three known facts across a synthetic archive. Its input grows with context: these rows measure capacity and prefill cost, not equal-work speed. Basic sweep wall times include up to one second of resource-sampler quantization; precise server prompt/decode timings are retained in JSON. Structured seconds are the median of the same correct 911-output-token answer at output ceilings 2,048/4,096/8,192 (only applicable ceilings at 8K), measured without that sampler. These are three budget conditions, not independent statistical repetitions. Finalist files add repeated workload measurements at the deployed 64K setting; 32K was not separately repeated, so small speed differences are not significant.

## Outcomes and output budgets

- Logic, Python reading, shared-length retrieval, growing-context retrieval and native calculator-tool selection passed at every size on both hosts. Tool selection tests the model's protocol, not execution of a calculator.
- Revision tracking, abstaining on an unspecified date, tenant-cache code review and two-request queue completion passed in the expanded workloads. Raijin 8K has only the basic suite; all other host/window pairs have the expanded suite.
- Raw arithmetic failed consistently: `137*29-418` is **3555**, but the model answered **3565**. Larger context does not repair this error. Codali should use deterministic calculation tools.
- Output ceilings tested: 512, 1,024, 2,048, 4,096 and 8,192 where they fit. The 512 ceiling truncates the 80-row JSON fixture; all larger ceilings return the same correct 911-token answer. The expected truncation is preserved in raw results, not counted as a service crash.
- Retained existing output policy: 4,096 model maximum in the tested Codali configuration, 2,048 for low effort, 1,024 for interaction; registered server-facing agents retain their existing 8,192 maximum. A ceiling is not a requirement to spend those tokens. No evidence supports increasing all response ceilings.
- 64K displaces about 496MiB/491MiB of expert cache relative to 32K on Raijin/Suku. Increasing to 256K displaces substantially more cache without improving matched answers in this fixture set.

## Deployment and verification

Effective service profiles are `~/.local/state/codali-terminal-deployment/strata-recovery-rollout1/raijin-profile.json` and `strata-resource-rollout2/suku-profile.json`. Profiles were resolved from the running process, backed up and changed one host at a time with mswarm admission drained. Standard install profiles were not the active configuration. Original backups remain in `~/.local/state/codali-context-sweep/` on each host.

Raijin's active Codali configuration `~/.config/codali/preview-26-v11-low.json` now advertises 65,536 for the two host entries and both stable Qwen aliases. Local agent registrations and the existing pinned Docdex load-balanced agent are aligned without changing its identity. Restart an existing Codali process to reload configuration.

`boundary-*.json` records near-limit success, clean over-limit rejection and successful subsequent recovery. `finalist-*.json` records repeat runs. `provider-probe.json` records the configured Codali provider check; the catalog evidence records both hosts' advertised capacity. No npm release was published.

## Reproduction and limits

Use the installed Strata Python environment, which supplies its tokenizer dependencies:

```sh
python scripts/benchmarks/context-sweep.py --sizes 8192,16384,32768,65536,131072,262144 --workload --output /tmp/context-sweep
python scripts/benchmarks/context-workload.py --repeat 3 --caps 1024,2048,4096,8192 --output /tmp/context-finalist.json
python scripts/benchmarks/context-boundary.py /tmp/context-boundary.json
```

The sweep restarts the local service and normally restores its original profile. Drain its mswarm node first, keep another host available, and resume admission after verification. `--apply-context 65536` only retains that explicit candidate if the implemented correctness, queue, headroom and relative generation-time gates pass. It does not automatically drain/resume mswarm. The read-only workload and boundary probes issue real inference requests.

This is capacity qualification with synthetic fixtures, not the 1,000-prompt Codali-versus-raw-Qwen intelligence benchmark. It does not establish the requested 10% intelligence gain or end-to-end token/time ratios. Long-agent reliability, image context, parallel slots, diverse natural documents and all possible output lengths are not established by these results. Model reload time was dominated by host I/O (especially Raijin); it is separate from answer latency. 128K/256K remain demonstrated options for a specifically justified long-input workload.
