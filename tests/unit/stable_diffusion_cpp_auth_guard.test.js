import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardScript = path.join(
  repoRoot,
  "packages",
  "mswarm",
  "scripts",
  "stable-diffusion-cpp-auth-guard.py",
);

function resolvePython() {
  for (const candidate of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

function waitForListening(child, stdout, stderr) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      reject(new Error(`auth guard did not become ready: ${stderr.join("")}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      buffered += chunk;
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.event !== "listening") continue;
          clearTimeout(timeout);
          resolve(event);
          return;
        } catch {
          // Ignore non-JSON startup output.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`auth guard exited before readiness with ${code}: ${stderr.join("")}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

function send(response, status, body, contentType = "application/json") {
  const encoded = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

test("stable-diffusion.cpp auth guard fails closed for invalid configuration", () => {
  const python = resolvePython();
  if (!python) return;
  const directory = mkdtempSync(path.join(os.tmpdir(), "mcoda-sd-guard-config-"));
  try {
    const emptyKey = path.join(directory, "empty-key");
    writeFileSync(emptyKey, "", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(emptyKey, 0o600);
    const missing = spawnSync(
      python,
      [guardScript, "--port", "0", "--api-key-file", path.join(directory, "missing")],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot be opened safely/);
    const empty = spawnSync(
      python,
      [guardScript, "--port", "0", "--api-key-file", emptyKey],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /contains an invalid token/);

    const validKey = path.join(directory, "valid-key");
    writeFileSync(validKey, "test-only-guard-key-0123456789abcdef\n", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(validKey, 0o600);
    const nonLoopback = spawnSync(
      python,
      [guardScript, "--host", "0.0.0.0", "--port", "0", "--api-key-file", validKey],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(nonLoopback.status, 0);
    assert.match(nonLoopback.stderr, /--host must be a loopback IP address/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "stable-diffusion.cpp auth guard authenticates and transparently bounds native traffic",
  { timeout: 30_000 },
  async (t) => {
    const python = resolvePython();
    if (!python) {
      t.skip("Python is unavailable");
      return;
    }
    const apiKey = "test-only-guard-key-0123456789abcdef";
    const directory = mkdtempSync(path.join(os.tmpdir(), "mcoda-sd-guard-"));
    const keyPath = path.join(directory, "api-key");
    writeFileSync(keyPath, `${apiKey}\n`, { encoding: "ascii", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(keyPath, 0o600);
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const modelBody = JSON.stringify({
      object: "list",
      data: [{ id: "sd-cpp-local", object: "model", owned_by: "local" }],
    });
    const successBody = JSON.stringify({
      created: 1785500000,
      output_format: "png",
      data: [{ b64_json: "iVBORw0KGgo=" }],
    });
    const rejectedBody = JSON.stringify({
      error: { message: "native rejected request", type: "invalid_request_error" },
    });
    let generationHits = 0;
    const native = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        send(response, 200, modelBody, "application/json; charset=utf-8");
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/images/generations") {
        send(response, 404, JSON.stringify({ error: "not found" }));
        return;
      }
      generationHits += 1;
      const raw = await readBody(request);
      const parsed = JSON.parse(raw.toString("utf8"));
      if (parsed.prompt === "upstream-rejected") {
        send(response, 422, rejectedBody, "application/json; charset=utf-8");
        return;
      }
      if (parsed.prompt === "upstream-disconnect") {
        response.socket.destroy();
        return;
      }
      if (parsed.prompt === "oversized-response") {
        send(response, 200, Buffer.alloc(2_048, 65), "application/json");
        return;
      }
      send(response, 200, successBody, "application/json");
    });
    await new Promise((resolve) => native.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => native.close(resolve)));
    const nativeAddress = native.address();

    const stdout = [];
    const stderr = [];
    const child = spawn(
      python,
      [
        guardScript,
        "--port",
        "0",
        "--upstream-base-url",
        `http://127.0.0.1:${nativeAddress.port}`,
        "--api-key-file",
        keyPath,
        "--max-request-bytes",
        "512",
        "--max-response-bytes",
        "1024",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    t.after(() => stopChild(child));
    const ready = await waitForListening(child, stdout, stderr);
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const authorizedHeaders = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    const generate = (prompt, headers = authorizedHeaders) =>
      fetch(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "sd-cpp-local", prompt }),
      });

    const missing = await fetch(`${baseUrl}/v1/models`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");
    assert.equal((await missing.json()).error.code, "invalid_api_key");
    const wrong = await generate("wrong token", {
      authorization: "Bearer definitely-wrong-token-0123456789",
      "content-type": "application/json",
    });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.type, "authentication_error");
    assert.equal(generationHits, 0);

    const models = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(models.status, 200);
    assert.equal(models.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await models.text(), modelBody);

    const generated = await generate("authorized success");
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get("content-type"), "application/json");
    assert.equal(await generated.text(), successBody);

    const rejected = await generate("upstream-rejected");
    assert.equal(rejected.status, 422);
    assert.equal(rejected.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await rejected.text(), rejectedBody);

    const disconnected = await generate("upstream-disconnect");
    assert.equal(disconnected.status, 502);
    assert.equal((await disconnected.json()).error.code, "upstream_unavailable");

    const beforeOversizedRequest = generationHits;
    const oversizedRequest = await generate("x".repeat(1_000));
    assert.equal(oversizedRequest.status, 413);
    assert.equal((await oversizedRequest.json()).error.code, "request_too_large");
    assert.equal(generationHits, beforeOversizedRequest);

    const oversizedResponse = await generate("oversized-response");
    assert.equal(oversizedResponse.status, 502);
    assert.equal((await oversizedResponse.json()).error.code, "upstream_response_too_large");

    await new Promise((resolve) => setTimeout(resolve, 25));
    const processOutput = `${stdout.join("")}\n${stderr.join("")}`;
    assert.equal(processOutput.includes(apiKey), false);
    assert.equal(child.exitCode, null);
  },
);
