# Tenant provisioning: logmira → mswarm

Design for item F of `logmira_integration_plan.md`. Written 2026-08-06 against
saas_be `18e2929`, mswarm `7cdf9fe`, codali 0.1.114.

Goal, as stated: creating a logmira tenant should register their mswarm
account, mint an API key, link it to that tenant's AI settings, and leave them
able to use the suku hardware.

No code has been written for this. Three decisions below change the shape of it
enough that guessing would mean building the wrong thing.

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

## What is missing

1. **mswarm has no programmatic provisioning endpoint.** `ApiKeyStore.issue`
   is a library call. Nothing exposes "create this tenant and give me a key"
   over HTTP, and nothing authenticates a machine caller like logmira to do it.
2. **logmira has nowhere to put the key.** `tenant-config` has no AI or mswarm
   settings, and the `api-keys` module is built for keys logmira *issues* — it
   hashes them, because it only ever needs to verify. An mswarm key must be
   replayed on every call, so it has to be recoverable, which means encrypted
   at rest with a managed key rather than hashed.
3. **Nothing grants a new tenant access to a node.** The allowlist is edited by
   the node owner in the console. Automation would have to add each new
   tenant's domain to whichever nodes they are entitled to — see decision 1.

## Decisions needed

### 1. Does a new tenant get the hardware automatically?

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

### 2. One mswarm account per logmira tenant, or one for logmira?

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

### 3. What happens when provisioning fails?

mswarm being down should not stop someone creating a tenant. The outbox will
retry, so the tenant exists with AI unavailable until it succeeds. That implies
a visible per-tenant state (`ai_provisioning: pending | ready | failed`) rather
than a silently missing key — otherwise the first symptom is a chat that
answers without tools, which is exactly the class of silent failure this
project has spent the week removing.

## Sketch, once those are settled

1. mswarm exposes provisioning behind a machine credential — create or fetch a
   tenant, issue a labelled key, return it once. Idempotent on tenant id, so an
   outbox retry cannot mint a second key.
2. saas_be gains `MswarmProvisioningService`, called from the existing
   `tenant.created` branch. It stores the key encrypted in tenant config and
   sets `ai_provisioning`.
3. Optional, per decision 1: add the tenant's domain to the entitled nodes'
   allowlists.
4. logmira passes that key, plus `tenant.slug`, into codali's `runContext`.
   Codali already carries the slug to mswarm and docdex, so nothing further is
   needed there.

## What must not happen

Codali resolves credentials from the operator's own files when a host does not
supply a context. That fallback is opt-in as of 0.1.113 and a tenant-scoped run
now refuses rather than borrowing the operator's identity. Provisioning must
not reintroduce it by writing tenant keys into a server-wide config: they
belong on the request, per run.
