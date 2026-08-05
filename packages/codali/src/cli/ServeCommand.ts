import path from "node:path";
import { startCodaliServer, type CodaliServerPrincipal } from "../api/CodaliServer.js";
import { LocalConfigRunContextResolver } from "../runcontext/RunContextResolver.js";

/**
 * `codali serve` — the local HTTP surface.
 *
 * Single-tenant by design: it authenticates against one operator-supplied key
 * and serves that operator's own configured context. Multi-tenant hosting is a
 * product's job, using {@link createCodaliServer} with its own `authenticate`
 * implementation, because only the product knows how to map a caller to a
 * tenant.
 */

const HELP = `Usage: codali serve [options]

Serve Codali over HTTP with the same result contract the CLI produces.

Endpoints:
  POST /v1/chat/completions   OpenAI-compatible; carries Codali provenance
  POST /v1/codali/run         Canonical Codali request/result
  GET  /healthz

Options:
  --port <n>                Port to listen on (default: 8787)
  --host <addr>             Address to bind (default: 127.0.0.1)
  --workspace-root <path>   Repository runs resolve against (default: cwd)
  --api-key <key>           Required key. Defaults to $CODALI_API_KEY.
  --help, -h                Show this help
`;

export const runServe = async (
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    write(HELP);
    return 0;
  }

  let port = 8787;
  let host = "127.0.0.1";
  let workspaceRoot = process.cwd();
  let apiKey = process.env.CODALI_API_KEY;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--port" && next) { port = Number.parseInt(next, 10); index += 1; }
    else if (arg === "--host" && next) { host = next; index += 1; }
    else if (arg === "--workspace-root" && next) { workspaceRoot = path.resolve(next); index += 1; }
    else if (arg === "--api-key" && next) { apiKey = next; index += 1; }
  }

  if (!apiKey) {
    // Refusing to start without a key is deliberate: an unauthenticated server
    // has no tenant, and a run with no tenant scope should not reach
    // connectors or credentials.
    write("codali serve requires an API key. Set CODALI_API_KEY or pass --api-key.");
    return 1;
  }

  const context = await new LocalConfigRunContextResolver().resolve({ workspaceRoot });
  const principal: CodaliServerPrincipal = {
    tenant: { id: "local", slug: "local" },
    runContext: context,
  };

  const { port: boundPort } = await startCodaliServer({
    port,
    host,
    workspaceRoot,
    authenticate: async (candidate) => (candidate === apiKey ? principal : undefined),
  });

  write(`codali serve listening on http://${host}:${boundPort}`);
  write("  POST /v1/chat/completions");
  write("  POST /v1/codali/run");
  return 0;
};

export const ServeCommand = {
  async run(argv: string[]): Promise<void> {
    const exitCode = await runServe(argv);
    if (exitCode !== 0) process.exitCode = exitCode;
  },
};
