import packageJson from '../../../package.json' with { type: 'json' };
import {
  MswarmConfigStore,
  type MswarmConfigState,
} from '@mcoda/core';
import {
  acceptMswarmConsent,
  buildMswarmApi,
} from './MswarmConsentFlow.js';

const USAGE = `
Usage: mcoda consent <show|accept|revoke|request-deletion> [options]

Subcommands:
  show                     Display the persisted mswarm consent state
  accept                   Register/refresh consent with mswarm and persist the local client identity
  revoke                   Revoke the currently stored mswarm consent token
  request-deletion         Submit a data deletion request to mswarm for this client identity

Options:
  --policy-version <VER>   Override the consent policy version for \`accept\`
  --reason <TEXT>          Attach a reason to \`revoke\` or \`request-deletion\`
  --json                   Emit JSON output
  --help                   Show this help
`.trim();

type ParsedConsentArgs = {
  subcommand?: string;
  json: boolean;
  policyVersion?: string;
  reason?: string;
};

type ConsentStatusPayload = {
  consentAccepted: boolean;
  consentTokenSet: boolean;
  clientId?: string;
  clientType?: string;
  policyVersion?: string;
  apiKeySet: boolean;
  baseUrl?: string;
  uploadSigningSecretSet: boolean;
  deletionRequestedAtMs?: number;
};

export class ConsentCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseConsentArgs(argv);
    if (!parsed.subcommand || argv.includes('--help') || argv.includes('-h')) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }

    const store = new MswarmConfigStore();
    const state = await store.readState();

    if (parsed.subcommand === 'show') {
      render(parsed.json, {
        consentAccepted: Boolean(state.consentAccepted),
        consentTokenSet: Boolean(state.consentToken?.trim()),
        clientId: state.clientId,
        clientType: state.clientType,
        policyVersion: state.consentPolicyVersion,
        apiKeySet: Boolean(state.apiKey?.trim()),
        baseUrl: state.baseUrl,
        uploadSigningSecretSet: Boolean(state.uploadSigningSecret?.trim()),
        deletionRequestedAtMs: state.deletionRequestedAtMs,
      });
      return;
    }

    if (parsed.subcommand === 'accept') {
      const nextState = await acceptMswarmConsent({
        state,
        policyVersion: parsed.policyVersion,
        productVersion: String(
          (packageJson as { version?: string }).version ?? 'dev'
        ),
      });
      render(parsed.json, {
        consentAccepted: Boolean(nextState.consentAccepted),
        consentTokenSet: Boolean(nextState.consentToken?.trim()),
        clientId: nextState.clientId,
        clientType: nextState.clientType,
        policyVersion: nextState.consentPolicyVersion,
        apiKeySet: Boolean(nextState.apiKey?.trim()),
        baseUrl: nextState.baseUrl,
        uploadSigningSecretSet: Boolean(nextState.uploadSigningSecret?.trim()),
        deletionRequestedAtMs: nextState.deletionRequestedAtMs,
      });
      return;
    }

    if (parsed.subcommand === 'revoke') {
      const consentToken = state.consentToken?.trim();
      if (!consentToken) {
        throw new Error(
          'No persisted mswarm consent token is available. Run `mcoda consent accept` first.'
        );
      }
      const api = await buildMswarmApi(state);
      try {
        const response = await api.revokeConsent(consentToken, parsed.reason);
        await store.clearConsentState();
        render(parsed.json, {
          revoked: response.revoked,
          revokedAtMs: response.revoked_at_ms ?? null,
        });
      } finally {
        await api.close();
      }
      return;
    }

    if (parsed.subcommand === 'request-deletion') {
      const consentToken = state.consentToken?.trim();
      if (!consentToken) {
        throw new Error(
          'No persisted mswarm consent token is available. Run `mcoda consent accept` first.'
        );
      }
      const api = await buildMswarmApi(state);
      try {
        const response = await api.requestDataDeletion({
          consentToken,
          product: 'mcoda',
          clientId: state.apiKey?.trim() ? undefined : state.clientId,
          clientType: state.apiKey?.trim() ? undefined : state.clientType,
          reason: parsed.reason,
        });
        const deletionRequestedAtMs = Date.now();
        await store.saveConsentState({
          consentAccepted: Boolean(state.consentAccepted),
          consentPolicyVersion: state.consentPolicyVersion,
          consentToken: state.consentToken,
          clientId: state.clientId,
          clientType: state.clientType,
          registeredAtMs: state.registeredAtMs,
          uploadSigningSecret: state.uploadSigningSecret,
          deletionRequestedAtMs,
        });
        render(parsed.json, {
          accepted: response.accepted,
          requestId: response.request_id,
          product: response.product,
          clientId: response.client_id,
          clientType: response.client_type,
          tenantId: response.tenant_id,
          status: response.status,
          requestedAt: response.requested_at,
          deletionRequestedAtMs,
        });
      } finally {
        await api.close();
      }
      return;
    }

    throw new Error(`Unknown consent subcommand: ${parsed.subcommand}`);
  }
}

export function parseConsentArgs(argv: string[]): ParsedConsentArgs {
  const parsed: ParsedConsentArgs = { json: false };
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') {
      parsed.json = true;
      continue;
    }
    if (value === '--policy-version') {
      const next = argv[index + 1];
      if (!next?.trim()) {
        throw new Error('--policy-version requires a value');
      }
      parsed.policyVersion = next.trim();
      index += 1;
      continue;
    }
    if (value === '--reason') {
      const next = argv[index + 1];
      if (!next?.trim()) {
        throw new Error('--reason requires a value');
      }
      parsed.reason = next.trim();
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      throw new Error(`Unknown consent flag: ${value}`);
    }
    positionals.push(value);
  }
  parsed.subcommand = positionals[0];
  return parsed;
}

function render(json: boolean, payload: Record<string, unknown>): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const fragments = Object.entries(payload).map(
    ([key, value]) => `${key}=${String(value)}`
  );
  // eslint-disable-next-line no-console
  console.log(fragments.join(' '));
}
