import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };
import { MswarmConfigStore } from '@mcoda/core';
import { acceptMswarmConsent } from '../commands/consent/MswarmConsentFlow.js';

export type ConsentBootstrapMode = 'setup' | 'postinstall' | 'install_local';
export type DeferredBehavior = 'log' | 'error';

export interface ConsentBootstrapPrompter {
  close(): void;
  question(prompt: string): Promise<string>;
}

export interface ConsentBootstrapOptions {
  mode?: ConsentBootstrapMode;
  onDeferred?: DeferredBehavior;
  policyVersion?: string;
  interactive?: boolean;
  logger?: (line: string) => void;
  prompter?: ConsentBootstrapPrompter;
  store?: MswarmConfigStore;
  termsText?: string;
  acceptConsent?: typeof acceptMswarmConsent;
}

export interface ConsentBootstrapResult {
  status: 'already_configured' | 'accepted' | 'deferred';
  consentAccepted: boolean;
  consentTokenSet: boolean;
  clientId?: string;
  clientType?: string;
  policyVersion?: string;
  message: string;
}

const ACCEPTED_RESPONSES = new Set(['accept', 'accepted', 'yes', 'y']);

export async function runMswarmConsentBootstrap(
  options: ConsentBootstrapOptions = {}
): Promise<ConsentBootstrapResult> {
  const logger = options.logger ?? defaultLogger;
  const store = options.store ?? new MswarmConfigStore();
  const state = await store.readState();
  const consentAccepted = Boolean(state.consentAccepted);
  const consentTokenSet = Boolean(state.consentToken?.trim());
  if (consentAccepted && consentTokenSet) {
    return {
      status: 'already_configured',
      consentAccepted,
      consentTokenSet,
      clientId: state.clientId,
      clientType: state.clientType,
      policyVersion: state.consentPolicyVersion,
      message: 'Telemetry consent is already configured for this mcoda client.',
    };
  }

  const interactive = resolveInteractive(options.interactive);
  if (!interactive) {
    const message =
      'Telemetry consent is required before using mcoda. Run `mcoda setup` or `mcoda consent accept` in an interactive terminal.';
    if ((options.onDeferred ?? 'error') === 'error') {
      throw new Error(message);
    }
    logger(message);
    return {
      status: 'deferred',
      consentAccepted,
      consentTokenSet,
      clientId: state.clientId,
      clientType: state.clientType,
      policyVersion: state.consentPolicyVersion,
      message,
    };
  }

  logger(
    `mcoda requires acceptance of the bundled mswarm data collection terms before ${describeMode(
      options.mode ?? 'setup'
    )}.`
  );
  logger('');
  const termsText = options.termsText ?? (await readBundledTermsText());
  for (const line of termsText.trim().split(/\r?\n/)) {
    logger(line);
  }
  logger('');
  logger('Type "accept" to agree and continue. Any other response aborts setup.');
  const prompter =
    options.prompter ??
    readline.createInterface({
      input,
      output,
    });
  try {
    const answer = (await prompter.question('Consent> ')).trim().toLowerCase();
    if (!ACCEPTED_RESPONSES.has(answer)) {
      throw new Error(
        'Telemetry consent was not accepted. mcoda cannot continue.'
      );
    }
  } finally {
    prompter.close();
  }

  const acceptConsent = options.acceptConsent ?? acceptMswarmConsent;
  const nextState = await acceptConsent({
    state,
    store,
    policyVersion: options.policyVersion,
    productVersion: String((packageJson as { version?: string }).version ?? 'dev'),
  });
  const message = `Telemetry consent accepted for ${[
    nextState.clientType,
    nextState.clientId,
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .trim()}.`.replace(/\s+\./, '.');
  logger(message);
  return {
    status: 'accepted',
    consentAccepted: Boolean(nextState.consentAccepted),
    consentTokenSet: Boolean(nextState.consentToken?.trim()),
    clientId: nextState.clientId,
    clientType: nextState.clientType,
    policyVersion: nextState.consentPolicyVersion,
    message,
  };
}

async function readBundledTermsText(): Promise<string> {
  const termsPath = resolveBundledTermsPath();
  try {
    return await fs.readFile(termsPath, 'utf8');
  } catch {
    return [
      'Mswarm Data Collection Terms And Consent',
      '',
      'Consent is required to use mcoda.',
      'By accepting, you allow anonymous or account-bound telemetry upload to mswarm, including consent proof, product activity, and agent rating data as described in the bundled terms document.',
      'You may later revoke consent or request deletion with `mcoda consent revoke` or `mcoda consent request-deletion`.',
    ].join('\n');
  }
}

function resolveBundledTermsPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'MSWARM_DATA_COLLECTION_TERMS.md'
  );
}

function resolveInteractive(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

function describeMode(mode: ConsentBootstrapMode): string {
  if (mode === 'postinstall') return 'using the installed mcoda CLI';
  if (mode === 'install_local') return 'completing the local mcoda install helper';
  return 'continuing mcoda setup';
}

function defaultLogger(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}
