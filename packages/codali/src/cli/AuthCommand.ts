import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  MICROSOFT_GRAPH_SCOPES,
  microsoftEndpoints,
  pollForDeviceCodeTokens,
  startDeviceCode,
  DeviceCodeError,
} from "../connectors/oauth/DeviceCodeAuth.js";
import { resolveCredential, resetCredentialCache } from "../runcontext/CredentialFile.js";

/**
 * `codali auth <provider>` — interactive sign-in for connectors that need a
 * user context rather than a static key.
 *
 * The refresh token is written back to `~/.codali/.creds`, which is the same
 * place every other credential lives, so a connector references it as
 * `env:MICROSOFT_REFRESH_TOKEN` exactly like any other secret.
 */

const CREDS = path.join(homedir(), ".codali", ".creds");

const HELP = `Usage: codali auth <provider>

Providers:
  microsoft    Sign in to Microsoft Graph via device code

Options:
  --tenant <id>      Directory (tenant) ID. Default: $MICROSOFT_TENANT_ID
  --client <id>      Application (client) ID. Default: $MICROSOFT_CLIENT_ID
  --scope "<a b c>"  Override the requested delegated scopes
  --help, -h         Show this help
`;

/**
 * Writes a key into the credentials file, replacing any existing entry.
 * Rewrites in place rather than appending, so re-authenticating does not leave
 * a stale token above the new one — the parser takes the last occurrence, and
 * relying on that is a trap.
 */
export const upsertCredential = (
  key: string,
  value: string,
  file: string = CREDS,
): void => {
  const lines = existsSync(file)
    ? readFileSync(file, "utf8").split(/\r?\n/)
    : ["# Codali credentials. Format: KEY=value", ""];

  let replaced = false;
  const output = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (output.length > 0 && output[output.length - 1] !== "") output.push("");
    output.push(`${key}=${value}`, "");
  }
  writeFileSync(file, output.join("\n"), "utf8");
  chmodSync(file, 0o600);
};

export interface AuthDependencies {
  write?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Injected in tests so polling does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  credsFile?: string;
}

const authMicrosoft = async (
  argv: string[],
  deps: AuthDependencies,
): Promise<number> => {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  resetCredentialCache();

  let tenant = resolveCredential("MICROSOFT_TENANT_ID");
  let client = resolveCredential("MICROSOFT_CLIENT_ID");
  let scope = MICROSOFT_GRAPH_SCOPES;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tenant" && next) { tenant = next; index += 1; }
    else if (arg === "--client" && next) { client = next; index += 1; }
    else if (arg === "--scope" && next) { scope = next; index += 1; }
  }

  if (!tenant || !client) {
    write("Microsoft sign-in needs a tenant and client id.");
    write("Add MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID to ~/.codali/.creds,");
    write("or pass --tenant and --client.");
    return 1;
  }

  const endpoints = microsoftEndpoints(tenant);
  const config = { ...endpoints, clientId: client, scope };

  let start;
  try {
    start = await startDeviceCode(config, deps.fetchImpl);
  } catch (error) {
    const detail = error instanceof DeviceCodeError ? error.message : String(error);
    write(`Could not start device sign-in: ${detail}`);
    if (detail.includes("7000218") || detail.toLowerCase().includes("public client")) {
      write("");
      write("The app needs public client flows enabled:");
      write("  Entra portal -> App registrations -> your app -> Authentication");
      write("  -> Advanced settings -> Allow public client flows -> Yes");
    }
    return 1;
  }

  write("");
  write(`  Open:  ${start.verificationUri}`);
  write(`  Code:  ${start.userCode}`);
  write("");
  write("Waiting for approval…");

  try {
    const tokens = await pollForDeviceCodeTokens(config, start, deps.fetchImpl, {
      sleep: deps.sleep,
      onPending: () => {},
    });

    if (!tokens.refreshToken) {
      // Without offline_access the grant is good for one hour and then gone,
      // which is not a workflow.
      write("Signed in, but no refresh token was returned.");
      write("The `offline_access` scope is required for a durable session.");
      return 1;
    }

    const file = deps.credsFile ?? CREDS;
    upsertCredential("MICROSOFT_REFRESH_TOKEN", tokens.refreshToken, file);
    upsertCredential("MICROSOFT_TENANT_ID", tenant, file);
    upsertCredential("MICROSOFT_CLIENT_ID", client, file);
    resetCredentialCache();

    write("");
    write("Signed in. Refresh token stored in ~/.codali/.creds");
    if (tokens.scope) {
      write("");
      write("Granted scopes:");
      for (const granted of tokens.scope.split(/\s+/).filter(Boolean)) {
        write(`  ${granted}`);
      }
    }
    return 0;
  } catch (error) {
    const detail = error instanceof DeviceCodeError ? error.message : String(error);
    write(`Sign-in failed: ${detail}`);
    if (detail.includes("consent") || detail.includes("65001")) {
      write("");
      write("Grant the delegated permissions first:");
      write("  Entra portal -> App registrations -> your app -> API permissions");
      write("  -> Add Microsoft Graph delegated permissions -> Grant admin consent");
    }
    return 1;
  }
};

export const runAuth = async (
  argv: string[],
  deps: AuthDependencies = {},
): Promise<number> => {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const [provider, ...rest] = argv;

  if (!provider || argv.includes("--help") || argv.includes("-h")) {
    write(HELP);
    return provider ? 0 : 1;
  }
  if (provider === "microsoft" || provider === "ms" || provider === "graph") {
    return authMicrosoft(rest, deps);
  }
  write(`Unknown auth provider: ${provider}\n\n${HELP}`);
  return 1;
};

export const AuthCommand = {
  async run(argv: string[]): Promise<void> {
    const exitCode = await runAuth(argv);
    if (exitCode !== 0) process.exitCode = exitCode;
  },
};
