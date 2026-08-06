# Tenant provisioning: logmira → mswarm

Design for item F of `logmira_integration_plan.md`. Written 2026-08-06 against
saas_be `18e2929`, mswarm `7cdf9fe`, codali 0.1.114.

Goal, as stated: creating a logmira tenant should register their mswarm
account, mint an API key, link it to that tenant's AI settings, and leave them
able to use the suku hardware.

**Decisions taken 2026-08-06:** every new tenant gets hardware access
automatically, and each logmira tenant is its own mswarm customer.

**Then the code said otherwise, and it matters.** saas_be is *already* mswarm's
system of record for API keys, so most of "register their mswarm account" does
not need building — and building it would create a second, competing path. The
design below is the corrected one. See "What the code already does" first.

---

## What already exists

The seam is there and in use. `TenantsService.createTenant()` emits
`tenant.created` through the outbox, and `outbox.processor.ts` already
dispatches that to a provisioning service:

```ts
case "tenant.created":
case "tenant.activated":
case "tenant.suspended": {
  await this.iamProvisioningService.provisionTenant({ id, name, status });
  break;
}
```

An `mswarmProvisioningService` alongside `iamProvisioningService` is the
natural shape. The outbox already gives retries, ordering and a dead-letter
path, so provisioning inherits them rather than reinventing them.

mswarm can mint keys: `ApiKeyStore.issue(tenantId, label)` in
`packages/core/src/api-keys.ts`, with `list` and `revoke` beside it.

Sharing a node with another tenant works as of `7cdf9fe`: a node's
`client_allowlist` accepts domain entries such as `wodo`, they survive
heartbeats, and codali 0.1.113 sends `x-mswarm-client-identity` on both model
and docdex calls so the allowlist is actually consulted.

## What the code already does — read this before building

mswarm and saas_be are already integrated for API keys, in both directions, and
it is live: `SAAS_BE_BASE_URL` and `SAAS_BE_SERVICE_TOKEN` are set in
`mswarm.env`.

- `POST /v1/admin/api-keys/:tenantId` issues a key, and under a per-tenant
  cutover flag it delegates to `saasBeClient.issueApiKey()` rather than minting
  locally. The response carries `source: "saas_be"`.
- mswarm validates keys by asking saas_be: `saasBeClient.introspectApiKey()`
  calls `POST /v1/api-keys/introspect` and requires an active key to return
  both `api_key_id` and `tenant_id`.

The consequence is the important part: **mswarm derives the tenant from
saas_be's answer, so there is no separate mswarm account to create.** A logmira
tenant's own key already authenticates against mswarm and already carries its
tenant identity. "Each tenant is its own mswarm customer" is therefore already
true in the sense that matters — separate key, separate identity, separate
usage — without provisioning a second account anywhere.

That removes the largest piece of the original plan, and it removes a real
hazard: a parallel provisioning path minting keys in mswarm's local store
would produce tenants that introspection cannot resolve.

## What is actually missing

1. **A key designated for AI use.** saas_be can already issue one. The catch is
   that a key secret is shown once at issuance, and codali needs to replay it
   on every run, so logmira has to keep it recoverable — encrypted at rest with
   a managed key. Its own `api-keys` module hashes what it issues, because it
   only ever verifies; this is a different requirement and needs its own store.
2. **Somewhere to put it.** `tenant-config` has no AI settings at all.
3. **Node access.** The allowlist is edited by the node owner in the console.
   With access now automatic, `tenant.created` has to add the tenant's domain
   to the shared node, which needs the PATCH the other developer built exposed
   to a machine caller.
4. **Cutover.** Key issuance delegates to saas_be only where the per-tenant
   `cp_cutover_policies` document, or the env default, enables it. A new tenant
   must land on the enabled side or its key will be minted in mswarm's local
   store and introspection will not resolve it.

## Decisions taken, and what follows from them

Both are recorded here because they carry consequences that outlive the choice.

**Hardware access is automatic for every new tenant.** Capacity is now a
function of signups. Two RTX 3090s serve every text, image, video and audio
model, and three concurrent questions already produced 315-second timeouts
during benchmarking, so a queue in front of the node stops being optional. The
`scheduling.priority` codali already sends (-10) orders work but does not bound
it. This should be built before the first cohort, not after.

**Each tenant is its own mswarm customer.** As above, this is already true via
per-tenant keys and introspection; no second account is provisioned.

### Superseded: does a new tenant get the hardware automatically?

Two RTX 3090s serve every model, plus image, video and audio. Three concurrent
questions already produced 315-second timeouts during benchmarking. Granting
every new tenant access on creation makes capacity a function of signups.

- **Opt-in** — provision the account and key at creation, add the tenant to a
  node's allowlist only when someone enables it. Safe, one manual step.
- **Automatic, plan-gated** — paid plans are added to the shared node, free
  plans get an account with no node access.
- **Automatic for all** — simplest, and the one that will eventually starve
  everyone.

I would take opt-in until there is a queue and a measured capacity number.

### Superseded: one mswarm account per logmira tenant, or one for logmira?

The request says "register their mswarm account", which reads as per-tenant.
It is worth being explicit, because the two are very different:

- **Per tenant** — each logmira tenant is an mswarm customer with its own key,
  quota and usage. Isolation and per-tenant billing come free. It also means
  logmira is signing customers up to another product, and every tenant needs an
  mswarm identity that someone owns.
- **One logmira account, tenants separated by client identity** — logmira holds
  one mswarm account; each tenant is a domain identity on the node allowlist.
  Much less to provision, and codali already sends the identity. Usage
  attribution then has to be logmira's job, not mswarm's.

The second is closer to what the plumbing already does, but it changes who
holds the billing relationship, so it is not mine to pick.

### Still open: what happens when provisioning fails?

mswarm being down should not stop someone creating a tenant. The outbox will
retry, so the tenant exists with AI unavailable until it succeeds. That implies
a visible per-tenant state (`ai_provisioning: pending | ready | failed`) rather
than a silently missing key — otherwise the first symptom is a chat that
answers without tools, which is exactly the class of silent failure this
project has spent the week removing.

## The build

1. saas_be gains `MswarmProvisioningService`, called from the existing
   `tenant.created` branch beside `iamProvisioningService`. It issues one
   AI-labelled key through its own api-keys module, stores the secret encrypted
   in tenant config, and sets `ai_provisioning`. Idempotent on tenant id, so an
   outbox retry cannot mint a second key.
2. Ensure the tenant is on the enabled side of the api-key-issuance cutover, or
   mswarm will not resolve its key.
3. Add the tenant's domain to the shared node's `client_allowlist`, which needs
   a machine-callable route for the PATCH that exists today only for the
   console.
4. logmira passes the key and `tenant.slug` into codali's `runContext`. Codali
   already carries the slug to both mswarm and docdex as of 0.1.113, and as of
   0.1.113 it refuses a tenant run that arrives without a context rather than
   using the operator's own — so this step is what makes tenant runs work at
   all, not merely what makes them attributable.

## What must not happen

Codali resolves credentials from the operator's own files when a host does not
supply a context. That fallback is opt-in as of 0.1.113 and a tenant-scoped run
now refuses rather than borrowing the operator's identity. Provisioning must
not reintroduce it by writing tenant keys into a server-wide config: they
belong on the request, per run.
