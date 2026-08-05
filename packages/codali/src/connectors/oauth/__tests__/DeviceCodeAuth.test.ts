import assert from "node:assert/strict";
import test from "node:test";
import {
  DeviceCodeError,
  MICROSOFT_GRAPH_SCOPES,
  microsoftEndpoints,
  pollForDeviceCodeTokens,
  refreshAccessToken,
  startDeviceCode,
} from "../DeviceCodeAuth.js";

const json = (payload: unknown): Response =>
  ({ async json() { return payload; } }) as unknown as Response;

const config = {
  ...microsoftEndpoints("tenant-1"),
  clientId: "client-1",
  scope: MICROSOFT_GRAPH_SCOPES,
};

const start = {
  deviceCode: "dev-1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://login.microsoft.com/device",
  expiresInSeconds: 900,
  intervalSeconds: 1,
};

const noSleep = async () => {};

test("offline_access is requested, or there is no durable session", () => {
  assert.match(MICROSOFT_GRAPH_SCOPES, /\boffline_access\b/);
});

test("the device code request returns a user code and verification uri", async () => {
  const result = await startDeviceCode(config, async () =>
    json({
      device_code: "d",
      user_code: "U-1",
      verification_uri: "https://x",
      expires_in: 900,
      interval: 5,
    }));
  assert.equal(result.userCode, "U-1");
  assert.equal(result.intervalSeconds, 5);
});

test("a disabled public-client app surfaces its error rather than hanging", async () => {
  await assert.rejects(
    () =>
      startDeviceCode(config, async () =>
        json({
          error: "invalid_client",
          error_description: "AADSTS7000218: public client flows disabled",
        })),
    (error: unknown) => {
      assert.ok(error instanceof DeviceCodeError);
      assert.equal(error.code, "invalid_client");
      return true;
    },
  );
});

test("authorization_pending is polled through, not treated as failure", async () => {
  let calls = 0;
  const tokens = await pollForDeviceCodeTokens(
    config,
    start,
    async () => {
      calls += 1;
      return calls < 3
        ? json({ error: "authorization_pending" })
        : json({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" });
    },
    { sleep: noSleep },
  );

  assert.equal(calls, 3);
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.refreshToken, "rt");
});

test("slow_down backs off instead of being ignored", async () => {
  const delays: number[] = [];
  let calls = 0;
  await pollForDeviceCodeTokens(
    config,
    start,
    async () => {
      calls += 1;
      return calls === 1
        ? json({ error: "slow_down" })
        : json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    },
    { sleep: async (ms) => { delays.push(ms); } },
  );

  assert.ok(delays[1]! > delays[0]!, "interval must grow after slow_down");
});

test("a declined authorization stops immediately", async () => {
  await assert.rejects(
    () =>
      pollForDeviceCodeTokens(config, start, async () => json({ error: "authorization_declined" }), {
        sleep: noSleep,
      }),
    /authorization_declined/,
  );
});

test("polling gives up when the code expires", async () => {
  let now = 0;
  await assert.rejects(
    () =>
      pollForDeviceCodeTokens(
        config,
        { ...start, expiresInSeconds: 2 },
        async () => json({ error: "authorization_pending" }),
        { sleep: async () => { now += 1000; }, now: () => now },
      ),
    /expired_token/,
  );
});

test("a refresh token is exchanged for an access token", async () => {
  let body = "";
  const tokens = await refreshAccessToken(
    { tokenUrl: config.tokenUrl, clientId: config.clientId, scope: "s" },
    "rt-1",
    async (_url, init) => {
      body = String(init?.body ?? "");
      return json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
    },
  );
  assert.match(body, /grant_type=refresh_token/);
  assert.equal(tokens.accessToken, "at-2");
  // Microsoft rotates refresh tokens; ignoring the new one strands the session.
  assert.equal(tokens.refreshToken, "rt-2");
});

test("an expired refresh token reports why rather than returning empty", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        { tokenUrl: config.tokenUrl, clientId: config.clientId, scope: "" },
        "dead",
        async () => json({ error: "invalid_grant", error_description: "AADSTS700082: expired" }),
      ),
    /invalid_grant/,
  );
});
