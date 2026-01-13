import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DocdexClient } from "../DocdexClient.js";

const shouldSkipDocdexClient =
  process.platform === "win32" || process.env.MCODA_SKIP_DOCDEX_CLIENT_TESTS === "1";

const startServer = async (): Promise<{ baseUrl: string; close: () => Promise<void>; headers: () => Record<string, string | string[] | undefined> }> => {
  let lastHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    lastHeaders = req.headers;
    const repoHeader = req.headers["x-docdex-repo-id"];
    const rootHeader = req.headers["x-docdex-repo-root"];
    if (url.pathname === "/search") {
      if (!repoHeader || !rootHeader) {
        res.statusCode = 400;
        res.end("missing_repo");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            {
              doc_id: "doc-1",
              doc_type: "SDS",
              path: "docs/sds/demo.md",
              title: "Demo SDS",
              snippet: "Snippet content",
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/snippet/")) {
      if (!repoHeader || !rootHeader) {
        res.statusCode = 400;
        res.end("missing_repo");
        return;
      }
      res.setHeader("Content-Type", "text/plain");
      res.end("Snippet detail");
      return;
    }
    if (url.pathname === "/v1/initialize") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ repoId: "repo-1" }));
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
    headers: () => ({ ...lastHeaders }),
    };
};

test("DocdexClient searches via docdex daemon and fetches snippets", async (t) => {
  if (shouldSkipDocdexClient) {
    t.skip("docdex client tests can hang on Windows CI");
    return;
  }
  const server = await startServer();
  try {
    const client = new DocdexClient({ baseUrl: server.baseUrl, workspaceRoot: "/tmp/ws" });
    const search = await client.search({ docType: "SDS", query: "demo" });
    assert.equal(search.length, 1);
    assert.equal(search[0].id, "doc-1");
    assert.equal(search[0].docType, "SDS");
    const headers = server.headers();
    assert.equal(headers["x-docdex-repo-id"], "repo-1");
    assert.ok(headers["x-docdex-repo-root"]);

    const fetched = await client.fetchDocumentById("doc-1");
    assert.equal(fetched.id, "doc-1");
    assert.ok(fetched.content?.includes("Snippet"));
  } finally {
    await server.close();
  }
});

test("DocdexClient falls back to local docs when baseUrl is missing", async (t) => {
  if (shouldSkipDocdexClient) {
    t.skip("docdex client tests can hang on Windows CI");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-docdex-"));
  const docPath = path.join(dir, "docs", "rfp.md");
  await fs.mkdir(path.dirname(docPath), { recursive: true });
  await fs.writeFile(docPath, "# RFP\nContent", "utf8");
  const client = new DocdexClient({ workspaceRoot: dir });

  try {
    const doc = await client.ensureRegisteredFromFile(docPath, "RFP", { projectKey: "proj" });
    assert.equal(doc.docType, "RFP");
    assert.ok(doc.segments && doc.segments.length > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
