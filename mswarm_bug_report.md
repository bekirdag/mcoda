# mswarm bug report — self-hosted OpenAI endpoint routes to OpenRouter

**Date:** 2026-08-05
**Service:** `api.mswarm.org`
**Severity:** blocking — no self-hosted model is callable through the OpenAI-compatible endpoint

---

## Summary

`GET /v1/swarm/self-hosted/openai/models` advertises self-hosted models.
`POST /v1/swarm/self-hosted/openai/chat/completions` on the same base path forwards those same model ids to **OpenRouter**, which rejects them as unknown.

One endpoint claims the model, the sibling endpoint does not route it.

---

## Reproduce

```sh
KEY=<mswarm api key>

# 1. The gateway says it serves this model.
curl -s -H "Authorization: Bearer $KEY" \
  https://api.mswarm.org/v1/swarm/self-hosted/openai/models \
  | grep qwen3.6
# -> {"id":"qwen3.6-llama.cpp", "agent_slug":"mcoda-sukunahikona-qwen3-6-llama-cpp", ...}

# 2. Calling it fails at OpenRouter.
curl -s -X POST https://api.mswarm.org/v1/swarm/self-hosted/openai/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.6-llama.cpp","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

### Actual

```json
{
  "error": "mswarm_error",
  "code": "validation_failed",
  "message": "OpenRouter error: 400 {\"error\":{\"message\":\"qwen3.6-llama.cpp is not a valid model ID\",\"code\":400}}",
  "request_id": "c83ca2fc-114b-472f-81ca-79b91960ea2b",
  "details": { "provider": "openrouter", "provider_status": 400 }
}
```

### Expected

Either the job is dispatched to the self-hosted node, or an error saying the node is unavailable. Never a handoff to OpenRouter — a local model name has no meaning there.

---

## Not model-specific

Same failure on a second self-hosted model, so it is the route rather than one bad registration:

| model | result | provider | request_id |
|---|---|---|---|
| `qwen3.6-llama.cpp` | `validation_failed` | openrouter | `c83ca2fc-114b-472f-81ca-79b91960ea2b` |
| `qwen3-4b-instruct-2507` | `validation_failed` | openrouter | `705a0579-382c-40d9-8029-fe76e2009510` |

Also tried and rejected the same way: agent slugs (`mcoda-cassandra-local-qwen-3-5-35b`), remote slugs (`mcoda/cassandra-local/qwq-reasoner`), and raw runner ids (`qwq:latest`). No naming form reaches the node.

---

## Node state, possibly related

`GET /v1/swarm/self-hosted/nodes`:

| node_id | status | node_version | unreachable_at |
|---|---|---|---|
| `shn_e258f734229544bf840978a2a59232c7` | online | 0.1.101 | 2026-08-05T00:16:54.917Z |
| `shn_e35f763823d1416ebddce1b5b20524bf` | **degraded** | 0.1.107 | 2026-08-05T00:16:54.917Z |

`qwen3.6-llama.cpp` lives on `shn_e35f7638…`, the degraded one.

Two questions for you:

1. Does a degraded or offline node cause the OpenRouter fallback? If so, the fallback itself is the bug — it should fail with "node unavailable" rather than forwarding a self-hosted model name to a cloud provider.
2. If the node being degraded is *not* the cause, then the self-hosted route is mis-wired independently and needs fixing regardless.

Note both nodes report the identical `unreachable_at`, which looks like a gateway-side sweep rather than two nodes independently dropping.

---

## Suggested fixes

1. **Never fall through to OpenRouter on the self-hosted route.** Failing loudly beats a confusing upstream 400 that blames the model name.
2. **Keep `/models` and `/chat/completions` consistent.** If `/models` lists it, `/chat/completions` should accept it — or `/models` should omit models whose node cannot currently serve them.
3. **Return a clearer error**, e.g. `{"code":"self_hosted_node_unavailable","node_id":"shn_…","model":"qwen3.6-llama.cpp"}`.
4. **Recover node `shn_e35f7638…`** (version 0.1.107, host `sukunahikona`).

---

## Impact

Codali needs a tool-capable model for orchestration. `qwen3.6-llama.cpp` is the right one — healthy in `mcoda agent list`, supports tool calls, 131k context. While this is broken, Codali falls back to a local 3B model that writes poor tool arguments, so multi-source questions return incomplete answers.

Not blocked on anything in `packages/mswarm` (that is the node client; it polls for jobs and does not serve this route).
