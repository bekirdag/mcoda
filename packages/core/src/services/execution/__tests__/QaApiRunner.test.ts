import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { QaApiRunner } from "../QaApiRunner.js";
import { PathHelper } from "@mcoda/shared";

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-api-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

const startServer = async (): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/login" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "demo-token" }));
      return;
    }
    if (req.url === "/protected") {
      const auth = req.headers.authorization ?? "";
      if (!auth.toString().includes("demo-token")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/schema-bad") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test("QaApiRunner executes requests and validates expectations", async () => {
  await withTempDir(async (dir) => {
    const server = await startServer();
    const runner = new QaApiRunner(dir);
    const artifactDir = path.join(PathHelper.getWorkspaceDir(dir), "jobs", "job-1", "qa", "task-1", "api");
    try {
      const result = await runner.run({
        baseUrl: server.baseUrl,
        requests: [
          {
            method: "GET",
            path: "/health",
            expect: { status: 200, json_contains: { status: "ok" } },
          },
        ],
        artifactDir,
      });
      assert.equal(result.outcome, "pass");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /GET/);
      assert.ok(result.artifacts.some((entry) => entry.endsWith("api-results.json")));
      for (const artifact of result.artifacts) {
        await fs.access(path.join(dir, artifact));
      }
    } finally {
      await server.close();
    }
  });
});

test("QaApiRunner fails when expectations are not met", async () => {
  await withTempDir(async (dir) => {
    const server = await startServer();
    const runner = new QaApiRunner(dir);
    try {
      const result = await runner.run({
        baseUrl: server.baseUrl,
        requests: [
          {
            method: "GET",
            path: "/error",
            expect: { status: 200 },
          },
        ],
      });
      assert.equal(result.outcome, "fail");
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Expected status/);
    } finally {
      await server.close();
    }
  });
});

test("QaApiRunner resolves base URL from package.json scripts", async () => {
  await withTempDir(async (dir) => {
    const runner = new QaApiRunner(dir);
    const pkg = {
      name: "demo",
      scripts: { dev: "PORT=4567 node server.js" },
    };
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    const baseUrl = await runner.resolveBaseUrl({ env: {} as any });
    assert.ok(baseUrl);
    assert.equal(baseUrl, "http://127.0.0.1:4567");
  });
});

test("QaApiRunner chains auth tokens across requests", async () => {
  await withTempDir(async (dir) => {
    const server = await startServer();
    const runner = new QaApiRunner(dir);
    try {
      const result = await runner.run({
        baseUrl: server.baseUrl,
        requests: [
          { method: "POST", path: "/login", expect: { status: 200 } },
          { method: "GET", path: "/protected", expect: { status: 200, json_contains: { ok: true } } },
        ],
      });
      assert.equal(result.outcome, "pass");
      assert.equal(result.exitCode, 0);
    } finally {
      await server.close();
    }
  });
});

test("QaApiRunner normalizes 0.0.0.0 base URLs to localhost", async () => {
  await withTempDir(async (dir) => {
    const runner = new QaApiRunner(dir);
    const baseUrl = await runner.resolveBaseUrl({
      env: { MCODA_QA_API_BASE_URL: "http://0.0.0.0:7777" } as any,
    });
    assert.ok(baseUrl);
    assert.equal(baseUrl, "http://127.0.0.1:7777");
  });
});

test("QaApiRunner validates response schema from OpenAPI spec", async () => {
  await withTempDir(async (dir) => {
    const server = await startServer();
    const runner = new QaApiRunner(dir);
    const spec = `
openapi: 3.0.0
info:
  title: Demo
  version: 1.0.0
paths:
  /schema-bad:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status:
                    type: string
`;
    await fs.writeFile(path.join(dir, "openapi.yaml"), spec, "utf8");
    try {
      const result = await runner.run({
        baseUrl: server.baseUrl,
        requests: [{ method: "GET", path: "/schema-bad", expect: { status: 200 } }],
      });
      assert.equal(result.outcome, "fail");
      assert.match(result.stderr, /Schema/);
    } finally {
      await server.close();
    }
  });
});

test("QaApiRunner suggests default requests from OpenAPI spec", async () => {
  await withTempDir(async (dir) => {
    const runner = new QaApiRunner(dir);
    const spec = `
openapi: 3.0.0
info:
  title: Demo
  version: 1.0.0
paths:
  /health:
    get:
      responses:
        "200":
          description: ok
  /auth/login:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email:
                  type: string
                  format: email
                password:
                  type: string
      responses:
        "200":
          description: ok
  /widgets:
    get:
      responses:
        "200":
          description: ok
`;
    await fs.writeFile(path.join(dir, "openapi.yaml"), spec, "utf8");
    const requests = await runner.suggestDefaultRequests();
    const paths = requests.map((req) => req.path);
    assert.ok(paths.includes("/health"));
    assert.ok(paths.includes("/auth/login"));
  });
});
