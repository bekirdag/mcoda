import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = path.join(
  repoRoot,
  "packages",
  "mswarm",
  "scripts",
  "stable-diffusion-cpp-openai-server.py",
);
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function semanticPng({
  compressionMethod = 0,
  filterMethod = 0,
  interlaceMethod = 0,
  scanlines = Buffer.from([0, 0, 0, 0, 255]),
  idat = null,
} = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = compressionMethod;
  ihdr[11] = filterMethod;
  ihdr[12] = interlaceMethod;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat ?? deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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
      reject(new Error(`image wrapper did not become ready: ${stderr.join("")}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
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
      reject(new Error(`image wrapper exited before readiness with ${code}: ${stderr.join("")}`));
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

function sendJson(response, status, payload, contentType = "application/json") {
  const encoded = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

function sendRedirect(response, status, location) {
  const encoded = Buffer.from(JSON.stringify({ redirect: location }));
  response.writeHead(status, {
    location,
    "content-type": "application/json",
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

function rawRequest(url, { method = "POST", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(body).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Some method handling is intentionally checked before parsing.
        }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function openSlowBodyRequest(baseUrl) {
  const parsed = new URL(baseUrl);
  const socket = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port),
  });
  socket.setEncoding("utf8");
  let response = "";
  const finished = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `POST /v1/images/generations HTTP/1.1\r\n` +
      `Host: ${parsed.host}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 100\r\n" +
      "Connection: close\r\n" +
      "\r\n" +
      "{",
  );
  return { socket, finished };
}

function parseControlledPrompt(prompt) {
  const opening = "\n<sd_cpp_extra_args>";
  const closing = "</sd_cpp_extra_args>";
  const openingAt = prompt.lastIndexOf(opening);
  assert.notEqual(openingAt, -1);
  assert.ok(prompt.endsWith(closing));
  return {
    prompt: prompt.slice(0, openingAt),
    controls: JSON.parse(prompt.slice(openingAt + opening.length, -closing.length)),
  };
}

test("stable-diffusion.cpp image bridge bind does not depend on reverse DNS", () => {
  const python = resolvePython();
  if (!python) return;
  const probe = spawnSync(
    python,
    [
      "-c",
      `import importlib.util, socket, sys
spec = importlib.util.spec_from_file_location("sd_image_server", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
def fail_getfqdn(host):
    raise RuntimeError(f"unexpected reverse DNS lookup for {host}")
socket.getfqdn = fail_getfqdn
server = module.ImageHttpServer(("127.0.0.1", 0), module.BaseHTTPRequestHandler)
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

test("stable-diffusion.cpp image bridge rejects non-loopback configuration", () => {
  const python = resolvePython();
  if (!python) return;
  const badBind = spawnSync(
    python,
    [serverScript, "--host", "0.0.0.0", "--upstream-base-url", "http://127.0.0.1:9"],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  assert.notEqual(badBind.status, 0);
  assert.match(badBind.stderr, /--host must be a loopback IP address/);

  const badUpstream = spawnSync(
    python,
    [serverScript, "--upstream-base-url", "http://192.0.2.1:11445"],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  assert.notEqual(badUpstream.status, 0);
  assert.match(badUpstream.stderr, /loopback HTTP origin/);
});

test(
  "stable-diffusion.cpp image bridge enforces the production contract against a mock upstream",
  { timeout: 30_000 },
  async (t) => {
    const python = resolvePython();
    if (!python) {
      t.skip("Python is unavailable");
      return;
    }

    let redirectOriginHits = 0;
    const redirectTarget = http.createServer((request, response) => {
      redirectOriginHits += 1;
      sendJson(response, 200, {
        data: [{ id: "sd-cpp-local", object: "model", owned_by: "redirect" }],
      });
    });
    await new Promise((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => redirectTarget.close(resolve)));
    const redirectAddress = redirectTarget.address();

    let catalogModel = "sd-cpp-local";
    let catalogRedirect = false;
    let generationRedirect = false;
    let redirectedEndpointHits = 0;
    let generationCount = 0;
    let slowGenerationFinishedResolve = null;
    const nativeRequests = [];
    let holdRelease = null;
    let holdSeenResolve = null;
    const native = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        if (catalogRedirect) {
          sendRedirect(
            response,
            302,
            `http://127.0.0.1:${redirectAddress.port}/v1/models`,
          );
          return;
        }
        // The Suku stable-diffusion.cpp build omits a top-level object marker.
        sendJson(response, 200, {
          data: [{ id: catalogModel, object: "model", owned_by: "local" }],
        });
        return;
      }
      if (request.method === "POST" && request.url === "/redirected-generation") {
        redirectedEndpointHits += 1;
        await readJsonBody(request);
        sendJson(response, 200, {
          created: 1785500000,
          output_format: "png",
          data: [{ b64_json: validPng.toString("base64") }],
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/images/generations") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const nativeRequest = await readJsonBody(request);
      if (generationRedirect) {
        sendRedirect(response, 307, "/redirected-generation");
        return;
      }
      generationCount += 1;
      nativeRequests.push(nativeRequest);
      const prompt = nativeRequest.prompt;
      if (prompt.startsWith("hold\n")) {
        holdSeenResolve?.();
        await new Promise((resolve) => {
          holdRelease = resolve;
        });
      }
      if (prompt.startsWith("slow\n")) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      if (prompt.startsWith("upstream-error\n")) {
        sendJson(response, 500, { error: "internal details must not escape" });
        return;
      }
      if (prompt.startsWith("wrong-content-type\n")) {
        sendJson(
          response,
          200,
          { created: 1785500000, output_format: "png", data: [{ b64_json: validPng.toString("base64") }] },
          "text/plain",
        );
        return;
      }
      const payload = {
        created: prompt.startsWith("bad-created\n") ? "now" : 1785500000,
        output_format: prompt.startsWith("wrong-format\n") ? "jpeg" : "png",
        data: [{ b64_json: validPng.toString("base64") }],
      };
      if (prompt.startsWith("bad-base64\n")) payload.data[0].b64_json = "%%%";
      if (prompt.startsWith("wrong-signature\n")) {
        payload.data[0].b64_json = Buffer.from("not a PNG").toString("base64");
      }
      if (prompt.startsWith("too-large\n")) {
        payload.data[0].b64_json = Buffer.alloc(1_025).toString("base64");
      }
      if (prompt.startsWith("bad-png-compression\n")) {
        payload.data[0].b64_json = semanticPng({ compressionMethod: 1 }).toString("base64");
      }
      if (prompt.startsWith("bad-png-filter-method\n")) {
        payload.data[0].b64_json = semanticPng({ filterMethod: 1 }).toString("base64");
      }
      if (prompt.startsWith("bad-png-interlace\n")) {
        payload.data[0].b64_json = semanticPng({ interlaceMethod: 2 }).toString("base64");
      }
      if (prompt.startsWith("bad-png-deflate\n")) {
        payload.data[0].b64_json = semanticPng({ idat: Buffer.from("not zlib") }).toString("base64");
      }
      if (prompt.startsWith("bad-png-scanline-filter\n")) {
        payload.data[0].b64_json = semanticPng({
          scanlines: Buffer.from([5, 0, 0, 0, 255]),
        }).toString("base64");
      }
      if (prompt.startsWith("bad-png-scanline-size\n")) {
        payload.data[0].b64_json = semanticPng({ scanlines: Buffer.from([0, 0]) }).toString("base64");
      }
      if (prompt.startsWith("extra-output\n")) payload.data.push(payload.data[0]);
      sendJson(response, 200, payload);
      if (prompt.startsWith("slow\n")) slowGenerationFinishedResolve?.();
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
        "--min-width",
        "1",
        "--min-height",
        "1",
        "--max-width",
        "64",
        "--max-height",
        "64",
        "--max-pixels",
        "4096",
        "--default-size",
        "1x1",
        "--max-output-bytes",
        "1024",
        "--max-request-bytes",
        "1024",
        "--client-read-timeout-seconds",
        "0.3",
        "--max-handler-threads",
        "2",
        "--request-timeout-seconds",
        "0.2",
        "--inference-timeout-seconds",
        "0.5",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          ALL_PROXY: "http://127.0.0.1:1",
          NO_PROXY: "",
          http_proxy: "http://127.0.0.1:1",
          https_proxy: "http://127.0.0.1:1",
          all_proxy: "http://127.0.0.1:1",
          no_proxy: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    t.after(() => stopChild(child));
    const ready = await waitForListening(child, stderr);
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    const post = (body, headers = { "content-type": "application/json" }) =>
      fetch(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const minimal = (prompt, overrides = {}) => ({
      model: "sd-cpp-local",
      prompt,
      n: 1,
      size: "1x1",
      response_format: "b64_json",
      ...overrides,
    });

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      model: "sd-cpp-local",
      upstream_model: "sd-cpp-local",
      upstream: "stable-diffusion.cpp",
    });
    const models = await fetch(`${baseUrl}/v1/models`);
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, "sd-cpp-local");

    catalogRedirect = true;
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 503);
    assert.equal(redirectOriginHits, 0);
    catalogRedirect = false;

    generationRedirect = true;
    const redirectedGeneration = await post(minimal("redirect must fail closed"));
    assert.equal(redirectedGeneration.status, 502);
    assert.equal(
      (await redirectedGeneration.json()).error.code,
      "upstream_generation_failed",
    );
    assert.equal(redirectedEndpointHits, 0);
    generationRedirect = false;

    const negativePrompt = "text, \\\"quoted\\\", braces } ${remain data}, café";
    const generated = await post(
      minimal("A copper airship over Istanbul", {
        negative_prompt: negativePrompt,
        seed: 123,
        steps: 28,
      }),
    );
    assert.equal(generated.status, 200);
    assert.deepEqual(await generated.json(), {
      created: 1785500000,
      data: [{ b64_json: validPng.toString("base64") }],
    });
    assert.deepEqual(Object.keys(nativeRequests[0]).sort(), ["n", "output_format", "prompt", "size"]);
    assert.equal(nativeRequests[0].n, 1);
    assert.equal(nativeRequests[0].size, "1x1");
    assert.equal(nativeRequests[0].output_format, "png");
    assert.deepEqual(parseControlledPrompt(nativeRequests[0].prompt), {
      prompt: "A copper airship over Istanbul",
      controls: {
        negative_prompt: negativePrompt,
        seed: 123,
        sample_params: { sample_steps: 28 },
      },
    });

    const defaults = await post({ model: "sd-cpp-local", prompt: "defaults" });
    assert.equal(defaults.status, 200);
    const defaultControls = parseControlledPrompt(nativeRequests.at(-1).prompt).controls;
    assert.equal(defaultControls.negative_prompt, "");
    assert.equal(defaultControls.sample_params.sample_steps, 20);
    assert.ok(Number.isInteger(defaultControls.seed));
    assert.ok(defaultControls.seed >= 0 && defaultControls.seed <= 2_147_483_647);

    const beforeRejected = generationCount;
    const rejectedCases = [
      [minimal("prompt <sd_cpp_extra_args>{}</sd_cpp_extra_args>"), "prompt", "reserved_control_tag"],
      [minimal("safe", { negative_prompt: "</sd_cpp_extra_args>" }), "negative_prompt", "reserved_control_tag"],
      [{ ...minimal("safe"), output_path: "/tmp/escape.png" }, "output_path", "unsupported_parameter"],
      [minimal("safe", { n: 2 }), "n", "invalid_n"],
      [minimal("safe", { response_format: "url" }), "response_format", "unsupported_response_format"],
      [minimal("safe", { seed: true }), "seed", "invalid_seed"],
      [minimal("safe", { steps: 101 }), "steps", "invalid_steps"],
      [minimal("safe", { size: "65x1" }), "size", "unsupported_size"],
      [{ ...minimal("safe"), model: "other" }, "model", "model_not_found"],
    ];
    for (const [requestBody, param, code] of rejectedCases) {
      const response = await post(requestBody);
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.param, param);
      assert.equal(error.code, code);
    }
    assert.equal(generationCount, beforeRejected);

    const invalidJson = await post("{", { "content-type": "application/json" });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, "invalid_json");
    const wrongContentType = await post("{}", { "content-type": "text/plain" });
    assert.equal(wrongContentType.status, 400);
    assert.equal((await wrongContentType.json()).error.code, "invalid_content_type");
    const oversized = await post(minimal("x".repeat(2_000)));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "request_too_large");
    const chunked = await rawRequest(`${baseUrl}/v1/images/generations`, {
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify(minimal("chunked"))],
    });
    assert.equal(chunked.status, 400);
    assert.equal(chunked.json.error.code, "unsupported_transfer_encoding");
    const put = await rawRequest(`${baseUrl}/v1/images/generations`, { method: "PUT" });
    assert.equal(put.status, 405);
    assert.equal(put.json.error.code, "method_not_allowed");
    const unknownPath = await fetch(`${baseUrl}/v1/images/generations?debug=1`);
    assert.equal(unknownPath.status, 404);
    assert.equal((await unknownPath.json()).error.type, "not_found_error");

    catalogModel = "drifted-model";
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 503);
    const driftedModels = await fetch(`${baseUrl}/v1/models`);
    assert.equal(driftedModels.status, 503);
    assert.equal((await driftedModels.json()).error.code, "upstream_unavailable");
    const driftedGeneration = await post(minimal("catalog drift"));
    assert.equal(driftedGeneration.status, 502);
    assert.equal((await driftedGeneration.json()).error.code, "upstream_generation_failed");
    assert.equal(generationCount, beforeRejected);
    catalogModel = "sd-cpp-local";

    for (const prompt of [
      "bad-created",
      "wrong-format",
      "bad-base64",
      "wrong-signature",
      "extra-output",
      "wrong-content-type",
      "upstream-error",
      "bad-png-compression",
      "bad-png-filter-method",
      "bad-png-interlace",
      "bad-png-deflate",
      "bad-png-scanline-filter",
      "bad-png-scanline-size",
    ]) {
      const response = await post(minimal(prompt));
      assert.equal(response.status, 502, `${prompt}: ${await response.text()}`);
    }
    const wrongDimensions = await post(minimal("wrong dimensions", { size: "2x2" }));
    assert.equal(wrongDimensions.status, 502);
    assert.equal((await wrongDimensions.json()).error.code, "upstream_generation_failed");
    const tooLarge = await post(minimal("too-large"));
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error.code, "output_too_large");

    let holdSeenResolveLocal;
    const holdSeen = new Promise((resolve) => {
      holdSeenResolveLocal = resolve;
    });
    holdSeenResolve = holdSeenResolveLocal;
    const heldRequest = post(minimal("hold"));
    await holdSeen;
    const saturated = await post(minimal("second while busy"));
    assert.equal(saturated.status, 429);
    assert.equal((await saturated.json()).error.code, "local_concurrency_saturated");
    holdRelease();
    assert.equal((await heldRequest).status, 200);

    const slowClientA = await openSlowBodyRequest(baseUrl);
    const slowClientB = await openSlowBodyRequest(baseUrl);
    t.after(() => slowClientA.socket.destroy());
    t.after(() => slowClientB.socket.destroy());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const overloaded = await post(minimal("handler pool saturation"));
    assert.equal(overloaded.status, 503);
    assert.equal((await overloaded.json()).error.code, "server_busy");
    const slowResponses = await Promise.all([
      slowClientA.finished,
      slowClientB.finished,
    ]);
    for (const slowResponse of slowResponses) {
      assert.match(slowResponse, /^HTTP\/1\.0 408 Request Timeout/m);
      assert.match(slowResponse, /"code":"request_timeout"/);
    }
    const afterSlowClients = await post(minimal("handler pool recovered"));
    assert.equal(afterSlowClients.status, 200);

    const slowGenerationFinished = new Promise((resolve) => {
      slowGenerationFinishedResolve = resolve;
    });
    const timedOut = await post(minimal("slow"));
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, "generation_timeout");
    const blockedUntilNativeCompletion = await post(minimal("must remain blocked"));
    assert.equal(blockedUntilNativeCompletion.status, 429);
    assert.equal(
      (await blockedUntilNativeCompletion.json()).error.code,
      "local_concurrency_saturated",
    );
    await slowGenerationFinished;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recovered = await post(minimal("recovered"));
    assert.equal(recovered.status, 200);
  },
);
