# @mcoda/agents

Agent registry, adapter wiring, and invocation helpers for mcoda.

## Install
- Requires Node.js >= 20.
- Install: `npm i @mcoda/agents`

## What it provides
- AgentService for resolving agents, prompts, capabilities, and secrets.
- Adapter interfaces (AgentAdapter, InvocationRequest/InvocationResult).
- Built-in adapters for OpenAI, Codex, Gemini, Ollama, Zhipu, local models, and QA.

## Example
```ts
import { AgentService } from "@mcoda/agents";

const service = await AgentService.create();
const agent = await service.resolveAgent("codex");
const adapter = await service.getAdapter(agent);
const result = await adapter.invoke?.({ input: "Summarize this repo." });

if (result) {
  console.log(result.output);
}

await service.close();
```

## Notes
- Primarily used by the mcoda CLI; APIs may evolve.
- Set `MCODA_STREAM_IO=1` to emit adapter I/O lines to stderr.
- If `~/.docdex/agents.md` exists, AgentService prepends it to every agent invocation.

## License
MIT - see `LICENSE`.
