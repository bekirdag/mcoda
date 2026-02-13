# Codali Architecture Plan: The "Local Codex" Engine

## 1. Core Philosophy: Event-Driven, Not Just Streaming
To mimic Codex, `codali` cannot just stream text. It must stream **Events**. The CLI UI must be able to switch modes instantly between "Printing Answer," "Showing Spinner (Thinking)," and "Rendering Markdown."

### The Data Flow
Instead of a simple string stream, the LLM Provider should yield an `AgentEvent`:
```typescript
type AgentEvent = 
  | { type: 'token', content: string }       // Standard text generation
  | { type: 'thought', content: string }     // "I need to check package.json..."
  | { type: 'tool_call', name: string, args: any } 
  | { type: 'tool_result', output: string }
  | { type: 'error', message: string }
```

---

## 2. Module Architecture

### A. The "Cortex" (Agent Loop)
This is the brain. It manages the conversation history and enforces the "ReAct" (Reason + Act) loop.

**Enhancement for Small Models (The "XML" Trick):**
Do NOT use JSON for tool calling with small models (CodeLlama/Mistral). It is too fragile. Use **XML-style tags** or specific stop sequences. It is much easier to parse a stream for `<cmd>ls -la</cmd>` using Regex than waiting for a full valid JSON object.

**The Workflow:**
1. **Input:** User types query.
2. **Context Injection (Docdex):** *Before* calling the LLM, `codali` queries `docdex` for relevant symbols/docs and injects them as a "System Note".
3. **Loop:**
   * **Stream:** LLM tokens print to screen.
   * **Detect:** Parser looks for tool triggers (e.g., `<cmd>...`).
   * **Interrupt:** If tool trigger found, stop printing text, show "Executing [cmd]..." spinner.
   * **Execute:** Run tool.
   * **Inject:** Feed result back to LLM context.
   * **Resume:** LLM continues generating based on new info.

### B. The "Synapse" (Providers & Adapters)
Implements the `LLMProvider` interface.
* **Standardization:** Normalizes output. OpenAI sends `delta.content`, Anthropic sends `content_block_delta`. The Adapter converts all of these into standard `AgentEvent` objects.
* **Ollama Special Handling:** Uses the `format: "json"` parameter *only* when we explicitly ask for structured data (like file parsing), but uses standard text for chat to preserve creativity.

### C. The "Hands" (Toolbelt)
Hardcoded, safe functions the LLM can invoke.

1. **`fs_read`**: Read file content (truncated if too large to fit context).
2. **`fs_list`**: List directory (not just names, but types).
3. **`docdex_search`**: (Your Integration) Search local vector index/documentation.
4. **`docdex_symbols`**: Find where a function/class is defined.
5. **`run_shell`**: (Sandboxed/Interactive) Run a shell command.

### D. The "Face" (UI Layer)
Use a library like **Ink** (React for CLI) or just standard ANSI codes with `process.stdout`.
* **State 1 (Streaming):** Append chars to buffer. Render Markdown via `marked-terminal` or similar.
* **State 2 (Tooling):** Dim the previous text. Show a spinner: `⠋ Reading src/app.ts...`.
* **State 3 (Complete):** Render final Markdown with syntax highlighting.

---

## 3. Docdex Integration Strategy

Docdex is your "Long Term Memory." Codex relies heavily on a similar mechanism called "The Graph."

**1. The Indexing Command (`codali index`)
* Scans the repo.
* Chunks files (split by functions/classes, not just lines).
* Generates embeddings (using Ollama `nomic-embed-text` or remote).
* Stores in a local SQLite/DuckDB or simple JSON vector store.

**2. The Retrieval Hook
Inside the `Cortex` (Agent Loop), before the first prompt is sent:
```typescript
// Pseudo-code
const context = [];
if (userQuery.includesCodeTerms()) {
   const docs = await tools.docdex_search(userQuery);
   context.push({ role: "system", content: `Context:\n${docs.join('\n')}` });
}
```
This primes the "dumb" model with smart context immediately, reducing the need for it to hallucinate commands to find files.

---

## 4. Implementation Steps (The "How-To")

### Step 1: The Robust Adapter (TypeScript)
Handle the network stream and fix the buffering issue.

```typescript
// src/adapters/ollama.ts
export async function* streamOllama(model: string, messages: any[]) {
  const response = await fetch("http://localhost:11434/api/chat", { ... });
  const reader = response.body?.getReader();
  // ... implementation of lineReader buffer logic ...
  
  for await (const line of lineReader(reader)) {
    const json = JSON.parse(line);
    // Simple heuristic: If it looks like a command, emit tool event
    if (json.message.content.includes('<cmd>')) {
       yield { type: 'tool_call', ... };
    } else {
       yield { type: 'token', content: json.message.content };
    }
  }
}
```

### Step 2: The Context Manager
You must manage the "Conversation Window."
* **Token Counting:** Approximate tokens (char count / 4).
* **Sliding Window:** If conversation > 4000 tokens (for CodeLlama), drop the *oldest* "Tool Result" logs first. They are the least valuable after the decision has been made.

### Step 3: The Tool Execution
```typescript
// src/tools/index.ts
export const toolbelt = {
  docdex_search: async (query: string) => {
    // Call your docdex binary or library
    return execSync(`docdex query "${query}"`).toString();
  },
  // ... other tools
};
```

### Step 4: The Main Event Loop
```typescript
async function main() {
  let history = [...initialPrompt];
  
  while (true) {
    const stream = adapter.stream(history);
    let currentResponse = "";
    
    for await (const event of stream) {
      if (event.type === 'token') {
        process.stdout.write(event.content);
        currentResponse += event.content;
      }
      else if (event.type === 'tool_call') {
        // 1. Pause UI
        // 2. Run Tool
        const result = await toolbelt[event.name](event.args);
        // 3. Add to history
        history.push({ role: 'assistant', content: currentResponse });
        history.push({ role: 'user', content: `Tool Output: ${result}` });
        // 4. BREAK loop and restart streaming with new history
        break; 
      }
    }
  }
}
```

---

## 5. Summary of Enhancements over Original Plan

1.  **Event-Based:** Replaces simple string streaming with an Event Emitter pattern.
2.  **Hybrid Parsing:** Suggests XML tags (`<cmd>`) over JSON for better compatibility with local models.
3.  **Docdex-First:** Promotes Docdex from a "Tool" to a "Context Injector" that runs *before* the model starts thinking.
4.  **Context Hygiene:** Adds explicit token management to prevent crashes on long debugging sessions.

```