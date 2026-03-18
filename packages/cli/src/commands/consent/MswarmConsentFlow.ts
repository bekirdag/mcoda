import { MswarmApi, MswarmConfigStore } from '@mcoda/core';
import {
  MCODA_FREE_CLIENT_TYPE,
  MSWARM_CONSENT_POLICY_VERSION,
  type MswarmConfigState,
} from '@mcoda/core';

export async function acceptMswarmConsent(options: {
  state?: MswarmConfigState;
  policyVersion?: string;
  productVersion?: string;
  store?: MswarmConfigStore;
} = {}): Promise<MswarmConfigState> {
  const store = options.store ?? new MswarmConfigStore();
  const state = options.state ?? (await store.readState());
  const api = await buildMswarmApi(state);
  try {
    const effectivePolicyVersion =
      options.policyVersion?.trim() ||
      state.consentPolicyVersion ||
      MSWARM_CONSENT_POLICY_VERSION;
    if (state.apiKey?.trim()) {
      const response = await api.issuePaidConsent(effectivePolicyVersion);
      const clientId = response.client_id || response.tenant_id || state.clientId;
      const clientType = response.client_type || 'paid_mcoda_client';
      if (!clientId) {
        throw new Error(
          'mswarm paid consent response did not include a client or tenant id'
        );
      }
      return store.saveConsentState({
        consentAccepted: true,
        consentPolicyVersion: effectivePolicyVersion,
        consentToken: response.consent_token,
        clientId,
        clientType,
        registeredAtMs: response.issued_at_ms ?? Date.now(),
        uploadSigningSecret: response.upload_signing_secret,
        deletionRequestedAtMs: state.deletionRequestedAtMs,
      });
    }

    const response = await api.registerFreeMcodaClient({
      clientId: state.clientId,
      policyVersion: effectivePolicyVersion,
      productVersion: options.productVersion?.trim() || 'dev',
    });
    const clientId = response.client_id || state.clientId;
    if (!clientId) {
      throw new Error(
        'mswarm free-client registration did not return a client id'
      );
    }
    return store.saveConsentState({
      consentAccepted: true,
      consentPolicyVersion: effectivePolicyVersion,
      consentToken: response.consent_token,
      clientId,
      clientType: response.client_type || MCODA_FREE_CLIENT_TYPE,
      registeredAtMs: response.issued_at_ms ?? Date.now(),
      uploadSigningSecret: response.upload_signing_secret,
      deletionRequestedAtMs: state.deletionRequestedAtMs,
    });
  } finally {
    await api.close();
  }
}

export async function buildMswarmApi(
  state: MswarmConfigState
): Promise<MswarmApi> {
  return MswarmApi.create({
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    timeoutMs: state.timeoutMs,
    agentSlugPrefix: state.agentSlugPrefix,
  });
}
