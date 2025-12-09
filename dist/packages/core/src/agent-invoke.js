import { spawn } from "node:child_process";
import { assemblePrompt } from "./prompt-assembler.js";
import { redactText, defaultRedactionRules } from "./redaction.js";
const fetchOpenAI = async (opts) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
    try {
        const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("No OpenAI API key provided; set agent auth or OPENAI_API_KEY (or use provider-specific login).");
        }
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: opts.model,
                messages: [
                    { role: "system", content: "You are a concise, structured assistant. Follow the instructions exactly." },
                    { role: "user", content: opts.prompt },
                ],
                temperature: 0.2,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`OpenAI request failed (${res.status}): ${text}`);
        }
        const json = (await res.json());
        const content = json.choices?.[0]?.message?.content;
        if (!content)
            throw new Error("OpenAI response missing content");
        return content;
    }
    finally {
        clearTimeout(timeout);
    }
};
const runLocalClient = async (opts) => {
    return new Promise((resolve, reject) => {
        const child = spawn(opts.cmd, opts.args, { stdio: ["pipe", "pipe", "pipe"] });
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Local client ${opts.cmd} timed out`));
        }, opts.timeoutMs ?? 45000);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(`Local client ${opts.cmd} exited with ${code}: ${stderr || stdout}`));
            }
            else {
                resolve(stdout.trim());
            }
        });
        child.stdin.write(opts.input);
        child.stdin.end();
    });
};
// Centralized agent call wrapper: assembles prompts, enforces docdex boundaries, and redacts logs before returning.
export const invokeAgent = async (options) => {
    const redactionRules = options.redactionRules ?? defaultRedactionRules;
    const agentName = options.agent.name ?? "unknown-agent";
    const provider = options.agent.provider ?? "unknown-provider";
    const model = options.agent.model ?? "unknown-model";
    const assemblyRequest = {
        command: options.command,
        agent: agentName,
        userPrompt: options.userPrompt,
        workspaceRoot: options.workspaceRoot,
        docPaths: options.docPaths,
        docdexAllowPaths: options.docdexAllowPaths,
        docdexMaxBytes: options.docdexMaxBytes,
        docdexChunkSize: options.docdexChunkSize,
        docdexMaxSegments: options.docdexMaxSegments,
        history: options.history,
        comments: options.comments,
        context: options.context,
        redactionRules,
    };
    const assembled = await assemblePrompt(assemblyRequest);
    const started = Date.now();
    let response;
    const simulate = () => `Simulated ${provider}/${model} response for ${options.command}. Prompt size=${assembled.prompt.length} chars.`;
    const lowerProvider = provider.toLowerCase();
    const tryLocal = async (cmd) => {
        try {
            return await runLocalClient({ cmd, args: ["exec", "--model", model], input: assembled.prompt });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(`${cmd} client failed (${message}); falling back to simulated response.`);
            return simulate();
        }
    };
    if (lowerProvider === "codex" || model.toLowerCase().includes("codex")) {
        // Prefer the local codex client regardless of API key presence.
        response = await tryLocal("codex");
    }
    else if (lowerProvider === "openai") {
        const apiKey = options.agent.authToken ?? process.env.OPENAI_API_KEY;
        if (apiKey) {
            try {
                response = await fetchOpenAI({ apiKey, model, prompt: assembled.prompt });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (/api key/i.test(message) || /invalid_api_key/i.test(message) || /No OpenAI API key/i.test(message)) {
                    // eslint-disable-next-line no-console
                    console.warn(`OpenAI call failed (${message}); trying local codex client (if available).`);
                    response = await tryLocal("codex");
                }
                else {
                    throw err;
                }
            }
        }
        else {
            response = await tryLocal("codex");
        }
    }
    else if (lowerProvider.includes("gemini")) {
        response = await tryLocal("gemini");
    }
    else {
        response = simulate();
    }
    const latencyMs = Date.now() - started + 5;
    const redactedResponse = redactText(response, redactionRules);
    return {
        prompt: assembled.prompt,
        redactedPrompt: assembled.redactedPrompt,
        response,
        redactedResponse,
        latencyMs,
        docSegmentsCount: assembled.docSegments.length,
    };
};
