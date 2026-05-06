# Prompt: Use mcoda Agents With mswarm

Use this prompt when you want an AI assistant to explain, operate, or integrate mcoda agents through mswarm.

## Prompt To Give The AI

```text
You are helping integrate mcoda agents with mswarm.

Goal:
- Use mcoda agents as the stable local and remote agent abstraction.
- Use mswarm as the gateway that exposes self-hosted mcoda agents and lets other mcoda clients call them.
- Use Codali for self-hosted mcoda execution when jobs need tool-style ping-pong, Docdex access, local search, file context, web search, or other runtime capabilities.
- Avoid raw provider=ollama for normal self-hosted agents. Raw Ollama is only a minimal fallback and does not provide the full Codali/Docdex orchestration loop.

Mental model:
- Owner machine: runs local models and local mcoda agents.
- mswarm node: runs on the owner machine, discovers healthy local mcoda agents, and exposes allowed agents to the mswarm gateway.
- Consumer machine or app: lists/syncs self-hosted mswarm agents into mcoda, then invokes them like normal mcoda agents.
- For Ollama-backed agents, the Ollama model remains stateless. Codali is the local runtime that keeps the loop going, evaluates tool needs, calls Docdex/search/file tools when allowed, and feeds results back into the model.

Default setup:
1. On the owner machine, install mcoda and mswarm.
2. Confirm local mcoda agents are healthy with `mcoda agent list --json --refresh-health`.
3. Install and start the mswarm node with an mswarm API key.
4. Prefer discovery mode `mcoda`, which is the default. Do not switch to `MSWARM_SELF_HOSTED_DISCOVERY_MODE=ollama` unless you intentionally want the raw fallback.
5. Use allow/block lists to control which local agents are exposed.
6. On the consumer side, store the mswarm API key, list available self-hosted agents, sync them into mcoda, then invoke the synced local agent slug.

Execution rules:
- For CLI usage, prefer `mcoda self-hosted agent sync` followed by `mcoda agent-run <synced-agent-slug>`.
- For programmatic usage, prefer the OpenAI-compatible mswarm self-hosted endpoint.
- Use the `default_model` value from `mcoda self-hosted agent list` as the OpenAI `model`.
- Use the synced local slug, usually `mswarm-self-hosted-...`, for `mcoda agent-run`.
- If Docdex is needed, pass Docdex runtime metadata through mcoda/OpenAI-compatible request metadata. Do not put secrets in prompts or request bodies.
- If streaming is available, prefer `stream: true` for long self-hosted runs so the gateway can return OpenAI-compatible SSE chunks.

Troubleshooting:
- If no agents appear, run `mswarm node doctor`, `mswarm node health`, and `mcoda agent list --json --refresh-health` on the owner machine.
- If an agent is present but cannot run, check `mswarm node logs --lines 200`.
- If a synced agent is stale, run `mcoda self-hosted agent sync --provider mcoda --prune`.
- If Docdex calls are missing, verify the request includes Docdex metadata, the self-hosted job is using provider `mcoda`, and the local node is executing through Codali rather than raw Ollama.
- If non-streaming calls time out through hosted infrastructure, retry with streaming enabled.

When answering the user, explain the exact commands to run for their role:
- "owner" means the machine exposing local agents.
- "consumer" means the machine or app invoking remote self-hosted agents.
- "programmatic" means direct API integration.
```

## Owner Machine Setup

Install the packages and confirm mcoda can see healthy local agents:

```bash
npm install -g mcoda @mcoda/mswarm
mcoda setup
mcoda agent list --json --refresh-health
```

`@mcoda/mswarm` ships the Codali runtime needed for self-hosted mcoda execution. Install `@mcoda/codali` separately only when you also want the standalone Codali CLI:

```bash
npm install -g @mcoda/codali
```

Install and start the self-hosted mswarm node:

```bash
printf '%s' "$MSWARM_API_KEY" | mswarm node install --api-key-stdin
mswarm node start
mswarm node status
mswarm node doctor
```

Expose only selected local agents:

```bash
printf '%s' "$MSWARM_API_KEY" | mswarm node install --api-key-stdin \
  --no-expose-all \
  --allow phi3-reviewer,qwen-3.5-35b,qwen3-coder
```

Useful node operations:

```bash
mswarm node health
mswarm node logs --lines 200
mswarm node restart
mswarm node stop
```

Important defaults:

```bash
# Default: discover mcoda agents and execute provider=mcoda jobs through Codali.
MSWARM_SELF_HOSTED_DISCOVERY_MODE=mcoda

# Only use this for the raw Ollama fallback.
MSWARM_SELF_HOSTED_DISCOVERY_MODE=ollama
```

## Consumer Machine Setup

Store the mswarm key for mcoda:

```bash
mcoda config set mswarm-api-key "$MSWARM_API_KEY"
```

List available self-hosted agents:

```bash
mcoda self-hosted agent list --provider mcoda --sorted-by-catalog-rating
mcoda self-hosted agent list --provider mcoda --json
mcoda self-hosted agent details "<remote-slug>" --json
```

Sync self-hosted agents into the local mcoda registry:

```bash
mcoda self-hosted agent sync --provider mcoda --prune
mcoda agent list --json --refresh-health
```

Run a synced self-hosted agent:

```bash
mcoda test-agent mswarm-self-hosted-<agent-slug>
mcoda agent-run mswarm-self-hosted-<agent-slug> \
  --prompt "Use the available project context and summarize the relevant implementation files."
```

## Programmatic OpenAI-Compatible Usage

The self-hosted OpenAI-compatible base URL is:

```text
https://api.mswarm.org/v1/swarm/self-hosted/openai/
```

Use the `default_model` shown by `mcoda self-hosted agent list --json` as the request `model`.

### Node.js

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MCODA_MSWARM_API_KEY,
  baseURL: "https://api.mswarm.org/v1/swarm/self-hosted/openai",
});

const model = process.env.MCODA_MSWARM_MODEL ?? "<default_model-from-list>";

const response = await client.chat.completions.create({
  model,
  stream: false,
  messages: [
    {
      role: "system",
      content:
        "You are a coding agent. Use available runtime context and ask for searches when needed.",
    },
    {
      role: "user",
      content: "Inspect the repository context and explain where the line item reviewer logic lives.",
    },
  ],
});

console.log(response.choices[0]?.message?.content ?? "");
```

### Streaming Node.js

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MCODA_MSWARM_API_KEY,
  baseURL: "https://api.mswarm.org/v1/swarm/self-hosted/openai",
});

const model = process.env.MCODA_MSWARM_MODEL ?? "<default_model-from-list>";

const stream = await client.chat.completions.create({
  model,
  stream: true,
  messages: [
    { role: "user", content: "Search the project context and produce a concise implementation plan." },
  ],
});

for await (const chunk of stream) {
  const text = chunk.choices[0]?.delta?.content;
  if (text) process.stdout.write(text);
}
```

### curl

```bash
curl -sS "https://api.mswarm.org/v1/swarm/self-hosted/openai/chat/completions" \
  -H "Authorization: Bearer $MSWARM_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "<default_model-from-list>",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "Use the available project context and explain the relevant files."
      }
    ]
  }'
```

## Docdex-Enabled Runtime Metadata

For managed mswarm agents inside mcoda, pass Docdex runtime context through invocation metadata. The OpenAI adapter forwards this only for managed mswarm agents and does not copy the raw mswarm key into the request body.

```ts
import { AgentService } from "@mcoda/agents";

const agentService = await AgentService.create();

try {
  const agent = await agentService.resolveAgent("mswarm-self-hosted-qwen-3-5-35b");
  const result = await agentService.invoke(agent.id, {
    input: "Use Docdex to find the reviewer module and summarize the call path.",
    metadata: {
      docdex: {
        base_url: "http://127.0.0.1:28491",
        repo_root: "/Users/example/Documents/apps/mswarm",
        repo_id: "optional-docdex-repo-id",
        required: true,
        credential_source: "attached_mswarm_api_key",
        allowed_operations: ["search", "snippet", "open", "chat_context"],
        capabilities: {
          search: true,
          snippet: true,
          open: true,
          chat_context: true,
          web: true,
        },
      },
    },
  });

  console.log(result.output);
} finally {
  await agentService.close();
}
```

Equivalent camelCase metadata is also accepted by the mcoda OpenAI adapter:

```ts
await agentService.invoke("mswarm-self-hosted-qwen-3-5-35b", {
  input: "Use Docdex and continue the investigation until you have evidence.",
  metadata: {
    docdexBaseUrl: "http://127.0.0.1:28491",
    docdexRepoRoot: process.cwd(),
    docdexRequired: true,
    docdexCredentialSource: "attached_mswarm_api_key",
    docdexAllowedOperations: ["search", "snippet", "open", "chat_context"],
  },
});
```

## Which Slug Or Model To Use

Use these values from `mcoda self-hosted agent list --json`:

- `remote_slug`: mswarm catalog identity for details and sync operations.
- `default_model`: OpenAI-compatible `model` value for API calls.
- synced local slug: mcoda local registry slug created by `mcoda self-hosted agent sync`, usually `mswarm-self-hosted-<agent-slug>`.

Example flow:

```bash
mcoda self-hosted agent list --provider mcoda --json
mcoda self-hosted agent details "mcoda/lab/qwen-3-5-35b" --json
mcoda self-hosted agent sync --provider mcoda --prune
mcoda agent-run mswarm-self-hosted-mcoda-lab-qwen-3-5-35b --prompt "Use Docdex context if available."
```

## Why This Enables Ollama Ping-Pong

Ollama models by themselves receive one prompt and return one answer. They do not own a durable terminal session, file search loop, Docdex access, or tool scheduler.

The intended self-hosted path is different:

```text
consumer mcoda or API client
  -> mswarm hosted gateway
  -> owner mswarm node
  -> local mcoda agent
  -> Codali runtime
  -> Ollama-backed model plus Docdex/search/file/web tool loop
```

That makes the local Ollama model behave more like a terminal coding client: the model can be prompted multiple times, Codali can evaluate the response, execute allowed searches or context reads, feed results back, and continue until the task reaches a final answer or policy limit.
