/**
 * OAuth 2.0 device authorization grant (RFC 8628).
 *
 * The right flow for a CLI. Authorization-code needs a redirect URI and a local
 * web server; client-credentials gets app-only permissions, which for
 * "summarize *my* mail" would mean reading the entire tenant — both overreach
 * and a different consent conversation.
 *
 * Device code needs neither: the user is shown a short code, approves in a
 * browser on any device, and we receive an access token plus a refresh token.
 * The refresh token is what gets stored; access tokens live about an hour and
 * are minted on demand.
 */

export interface DeviceCodeStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
  message?: string;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scope?: string;
  tokenType: string;
}

export interface DeviceCodeConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
}

export class DeviceCodeError extends Error {
  readonly code: string;
  readonly description?: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "DeviceCodeError";
    this.code = code;
    this.description = description;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const form = (values: Record<string, string>): string =>
  new URLSearchParams(values).toString();

export const startDeviceCode = async (
  config: DeviceCodeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeStartResult> => {
  const response = await fetchImpl(config.deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: config.clientId, scope: config.scope }),
  });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.device_code !== "string") {
    const code = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : "device_code_failed";
    const description = isRecord(payload) && typeof payload.error_description === "string"
      ? payload.error_description
      : undefined;
    throw new DeviceCodeError(code, description);
  }
  return {
    deviceCode: payload.device_code,
    userCode: String(payload.user_code ?? ""),
    verificationUri: String(payload.verification_uri ?? payload.verification_url ?? ""),
    expiresInSeconds: Number(payload.expires_in ?? 900),
    // The spec's default is 5s. Polling faster earns `slow_down`.
    intervalSeconds: Number(payload.interval ?? 5),
    message: typeof payload.message === "string" ? payload.message : undefined,
  };
};

const parseTokens = (payload: Record<string, unknown>): DeviceCodeTokens => ({
  accessToken: String(payload.access_token),
  refreshToken:
    typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  expiresInSeconds: Number(payload.expires_in ?? 3600),
  scope: typeof payload.scope === "string" ? payload.scope : undefined,
  tokenType: String(payload.token_type ?? "Bearer"),
});

export interface PollOptions {
  onPending?: (secondsRemaining: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls until the user approves, declines, or the code expires.
 *
 * `authorization_pending` is the normal state and must not be treated as an
 * error; `slow_down` requires backing off, and ignoring it gets the request
 * throttled.
 */
export const pollForDeviceCodeTokens = async (
  config: DeviceCodeConfig,
  start: DeviceCodeStartResult,
  fetchImpl: typeof fetch = fetch,
  options: PollOptions = {},
): Promise<DeviceCodeTokens> => {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = now() + start.expiresInSeconds * 1000;
  let intervalMs = start.intervalSeconds * 1000;

  while (now() < deadline) {
    await sleep(intervalMs);

    const response = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: start.deviceCode,
      }),
    });
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      throw new DeviceCodeError("invalid_token_response");
    }

    if (typeof payload.access_token === "string") {
      return parseTokens(payload);
    }

    const error = typeof payload.error === "string" ? payload.error : "unknown_error";
    const description =
      typeof payload.error_description === "string" ? payload.error_description : undefined;

    if (error === "authorization_pending") {
      options.onPending?.(Math.max(0, Math.round((deadline - now()) / 1000)));
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    // authorization_declined, expired_token, bad_verification_code, or a
    // consent/permission failure — all terminal.
    throw new DeviceCodeError(error, description);
  }

  throw new DeviceCodeError("expired_token", "The device code expired before approval.");
};

/**
 * Exchanges a stored refresh token for a fresh access token.
 *
 * Microsoft rotates refresh tokens, so the response may carry a new one; a
 * caller that ignores it will find its stored token dead after the old one's
 * sliding window closes.
 */
export const refreshAccessToken = async (
  config: Omit<DeviceCodeConfig, "deviceCodeUrl">,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeTokens> => {
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
      scope: config.scope,
    }),
  });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    const code = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : "refresh_failed";
    const description = isRecord(payload) && typeof payload.error_description === "string"
      ? payload.error_description
      : undefined;
    throw new DeviceCodeError(code, description);
  }
  return parseTokens(payload);
};

/** Microsoft identity platform endpoints for a tenant. */
export const microsoftEndpoints = (tenantId: string) => ({
  deviceCodeUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`,
  tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
});

/**
 * Delegated Graph scopes Codali asks for, matching what okacam's
 * `microsoft-integration-service` already requests. `offline_access` is what
 * yields a refresh token — without it the grant is good for one hour and then
 * gone.
 */
export const MICROSOFT_GRAPH_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/User.ReadBasic.All",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Chat.Read",
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/Contacts.Read",
  "https://graph.microsoft.com/People.Read",
].join(" ");
