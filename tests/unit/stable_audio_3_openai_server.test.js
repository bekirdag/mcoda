import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = path.join(
  repoRoot,
  "packages",
  "mswarm",
  "scripts",
  "stable-audio-3-openai-server.py",
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

function waitForListening(child, stderr) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      reject(new Error(`audio wrapper did not become ready: ${stderr.join("")}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      try {
        const event = JSON.parse(line);
        if (event.event !== "listening") return;
        clearTimeout(timeout);
        resolve(event);
      } catch {
        // Ignore non-JSON startup output.
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`audio wrapper exited before readiness with ${code}: ${stderr.join("")}`));
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

test("Stable Audio wrapper exposes a bounded OpenAI-shaped contract", { timeout: 20_000 }, async (t) => {
  const python = resolvePython();
  if (!python) {
    t.skip("Python is unavailable");
    return;
  }

  const stderr = [];
  const child = spawn(python, [serverScript, "--backend", "mock", "--port", "0"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  t.after(() => stopChild(child));

  const ready = await waitForListening(child, stderr);
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.model, "stable-audio-3-local");
  assert.equal(health.backend, "mock");

  const modelsResponse = await fetch(`${baseUrl}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.data[0].id, "stable-audio-3-local");

  const generationResponse = await fetch(`${baseUrl}/v1/audio/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stable-audio-3-local",
      prompt: "A short analog synth pulse",
      duration_seconds: 3,
      response_format: "wav",
      n: 1,
      seed: 7,
      steps: 8,
    }),
  });
  assert.equal(generationResponse.status, 200);
  const generation = await generationResponse.json();
  assert.equal(generation.model, "stable-audio-3-local");
  assert.equal(generation.data.length, 1);
  assert.equal(generation.data[0].mime_type, "audio/wav");
  assert.equal(generation.data[0].sample_rate, 44_100);
  assert.equal(generation.data[0].seed, 7);
  assert.equal(Buffer.from(generation.data[0].b64_audio, "base64").subarray(0, 4).toString(), "RIFF");

  const unsupportedResponse = await fetch(`${baseUrl}/v1/audio/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stable-audio-3-local",
      prompt: "A short analog synth pulse",
      duration_seconds: 3,
      negative_prompt: "speech",
    }),
  });
  assert.equal(unsupportedResponse.status, 400);
  const unsupported = await unsupportedResponse.json();
  assert.equal(unsupported.error.param, "negative_prompt");
  assert.equal(unsupported.error.code, "unsupported_parameter");

  const unknownResponse = await fetch(`${baseUrl}/v1/audio/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stable-audio-3-local",
      prompt: "A short analog synth pulse",
      duration_seconds: 3,
      output_path: "/tmp/escape.wav",
    }),
  });
  assert.equal(unknownResponse.status, 400);
  const unknown = await unknownResponse.json();
  assert.equal(unknown.error.param, "output_path");
});

test("Stable Audio wrapper runs the canonical CLI in a fresh subprocess", { timeout: 20_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable test");
    return;
  }
  const python = resolvePython();
  if (!python) {
    t.skip("Python is unavailable");
    return;
  }

  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "mcoda-stable-audio-"));
  const requiredFiles = [
    path.join(runtimeRoot, "scripts", "tokenizer.json"),
    path.join(runtimeRoot, "models", "sm_86", "t5gemma", "t5gemma_fp16mixed.trt"),
    path.join(runtimeRoot, "models", "sm_86", "sa3-m", "dit_fp16mixed.trt"),
    path.join(runtimeRoot, "models", "sm_86", "same-l", "dec_dynamic_triton_swa.trt"),
  ];
  for (const requiredFile of requiredFiles) {
    await mkdir(path.dirname(requiredFile), { recursive: true });
    await writeFile(requiredFile, "test");
  }
  const venvPython = path.join(runtimeRoot, ".venv", "bin", "python");
  await mkdir(path.dirname(venvPython), { recursive: true });
  await symlink(python, venvPython);
  const fakeEntrypoint = path.join(runtimeRoot, "scripts", "sa3_trt.py");
  await writeFile(fakeEntrypoint, `import argparse, os, wave\nfrom pathlib import Path\np = argparse.ArgumentParser()\np.add_argument("--prompt")\np.add_argument("--seconds", type=float)\np.add_argument("--seed", type=int)\np.add_argument("--out")\na, _ = p.parse_known_args()\nroot = Path(__file__).parent.parent\nwith (root / "invocations").open("a") as log:\n    log.write(f"{os.getpid()}\\n")\nout = Path(a.out)\nwith wave.open(str(out), "wb") as w:\n    w.setnchannels(2)\n    w.setsampwidth(2)\n    w.setframerate(44100)\n    w.writeframes(b"\\x00" * int(round(a.seconds * 44100)) * 4)\nif a.prompt == "__truncate__":\n    out.write_bytes(out.read_bytes()[:-4])\n`);

  const stderr = [];
  const child = spawn(
    python,
    [
      serverScript,
      "--runtime-root",
      runtimeRoot,
      "--dit",
      "medium",
      "--decoder",
      "same-l",
      "--port",
      "0",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  t.after(async () => {
    await stopChild(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const ready = await waitForListening(child, stderr);
  assert.equal(ready.backend, "subprocess");
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/audio/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stable-audio-3-local",
      prompt: "--cinematic $(this is data, not a shell command)",
      duration_seconds: 3,
      response_format: "wav",
      n: 1,
      seed: 1234,
      steps: 8,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].seed, 1234);
  assert.equal(body.data[0].sample_rate, 44_100);
  assert.equal(Buffer.from(body.data[0].b64_audio, "base64").subarray(0, 4).toString(), "RIFF");

  const invocationPids = (await readFile(path.join(runtimeRoot, "invocations"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(invocationPids.length, 2);
  assert.equal(new Set(invocationPids).size, 2);

  for (const invalidPrompt of ["embedded\u0000null", "lone surrogate \ud800"]) {
    const invalidResponse = await fetch(
      `http://127.0.0.1:${ready.port}/v1/audio/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stable-audio-3-local",
          prompt: invalidPrompt,
          duration_seconds: 3,
        }),
      },
    );
    assert.equal(invalidResponse.status, 400);
    const invalidBody = await invalidResponse.json();
    assert.equal(invalidBody.error.param, "prompt");
    assert.equal(invalidBody.error.code, "invalid_prompt");
  }

  const truncatedResponse = await fetch(
    `http://127.0.0.1:${ready.port}/v1/audio/generations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "stable-audio-3-local",
        prompt: "__truncate__",
        duration_seconds: 3,
      }),
    },
  );
  assert.equal(truncatedResponse.status, 500);
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 1);
});
