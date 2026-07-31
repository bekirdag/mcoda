import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = path.join(
  repoRoot,
  "packages",
  "mswarm",
  "scripts",
  "wan22-openai-server.py",
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
      reject(new Error(`Wan wrapper did not become ready: ${stderr.join("")}`));
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
      reject(new Error(`Wan wrapper exited before readiness with ${code}: ${stderr.join("")}`));
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

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const encoded = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

test("Wan bridge bind does not depend on reverse DNS", () => {
  const python = resolvePython();
  if (!python) return;
  const probe = spawnSync(
    python,
    [
      "-c",
      `import importlib.util, socket, sys
spec = importlib.util.spec_from_file_location("wan22_server", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
def fail_getfqdn(host):
    raise RuntimeError(f"unexpected reverse DNS lookup for {host}")
socket.getfqdn = fail_getfqdn
server = module.VideoHttpServer(("127.0.0.1", 0), module.BaseHTTPRequestHandler)
assert server.server_name == "127.0.0.1"
assert server.server_port > 0
server.server_close()
`,
      serverScript,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
});

test("Wan bridge maps bounded OpenAI video requests to native async jobs", { timeout: 20_000 }, async (t) => {
  const python = resolvePython();
  if (!python) {
    t.skip("Python is unavailable");
    return;
  }

  let nativeRequest;
  let submissionCount = 0;
  let cancelCount = 0;
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("mock-webm")]);
  const native = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/sdcpp/v1/capabilities") {
      sendJson(response, 200, {
        supported_modes: ["vid_gen"],
        output_formats_by_mode: { vid_gen: ["webm"] },
      });
      return;
    }
    if (request.method === "POST" && request.url === "/sdcpp/v1/vid_gen") {
      nativeRequest = await readJsonBody(request);
      submissionCount += 1;
      sendJson(response, 202, {
        id: "job_video_1",
        kind: "vid_gen",
        status: "queued",
        created: 1,
        poll_url: "/sdcpp/v1/jobs/job_video_1",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/sdcpp/v1/jobs/job_video_1") {
      if (nativeRequest?.prompt === "poll failure") {
        sendJson(response, 500, { error: "mock poll failure" });
        return;
      }
      sendJson(response, 200, {
        id: "job_video_1",
        kind: "vid_gen",
        status: "completed",
        result: {
          output_format: "webm",
          mime_type: nativeRequest?.prompt === "bad mime" ? "video/mp4" : "video/webm",
          fps: nativeRequest?.fps,
          frame_count: 29,
          b64_json: webm.toString("base64"),
        },
        error: null,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/sdcpp/v1/jobs/job_video_1/cancel") {
      await readJsonBody(request);
      cancelCount += 1;
      sendJson(response, 200, { id: "job_video_1", status: "cancelled" });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => native.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => native.close(resolve)));
  const nativeAddress = native.address();

  const stderr = [];
  const child = spawn(
    python,
    [
      serverScript,
      "--port",
      "0",
      "--upstream-base-url",
      `http://127.0.0.1:${nativeAddress.port}`,
      "--poll-interval-seconds",
      "0.01",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  t.after(() => stopChild(child));
  const ready = await waitForListening(child, stderr);
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const models = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.equal(models.data[0].id, "wan2.2-t2v-a14b-q4-k-m-local");

  const generated = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "wan2.2-t2v-a14b-q4-k-m-local",
      prompt: "A fox crossing a snowy clearing",
      negative_prompt: "text, watermark",
      size: "832x480",
      duration_seconds: 2,
      fps: 16,
      response_format: "webm",
      n: 1,
      seed: 7,
      steps: 10,
      high_noise_steps: 8,
    }),
  });
  assert.equal(generated.status, 200);
  const body = await generated.json();
  assert.equal(body.model, "wan2.2-t2v-a14b-q4-k-m-local");
  assert.equal(body.data[0].mime_type, "video/webm");
  assert.equal(body.data[0].response_format, "webm");
  assert.equal(body.data[0].frame_count, 29);
  assert.equal(body.data[0].duration_seconds, 29 / 16);
  assert.equal(body.data[0].seed, 7);
  assert.deepEqual(Buffer.from(body.data[0].b64_video, "base64"), webm);
  assert.equal(nativeRequest.video_frames, 32);
  assert.equal(nativeRequest.sample_params.sample_steps, 10);
  assert.equal(nativeRequest.high_noise_sample_params.sample_steps, 8);
  assert.equal(nativeRequest.negative_prompt, "text, watermark");

  const ambiguous = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "wan2.2-t2v-a14b-q4-k-m-local",
      prompt: "A fox",
      duration_seconds: 2,
      video_frames: 33,
    }),
  });
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json()).error.code, "ambiguous_duration");

  const unknown = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "wan2.2-t2v-a14b-q4-k-m-local",
      prompt: "A fox",
      output_path: "/tmp/escape.webm",
    }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.param, "output_path");
  assert.equal(submissionCount, 1);

  const malformed = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "wan2.2-t2v-a14b-q4-k-m-local",
      prompt: "bad mime",
      video_frames: 32,
    }),
  });
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json()).error.code, "upstream_generation_failed");

  const pollFailure = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "wan2.2-t2v-a14b-q4-k-m-local",
      prompt: "poll failure",
      video_frames: 33,
    }),
  });
  assert.equal(pollFailure.status, 502);
  assert.equal((await pollFailure.json()).error.code, "upstream_generation_failed");
  assert.equal(cancelCount, 1);
});
