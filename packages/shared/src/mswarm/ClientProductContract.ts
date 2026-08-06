/**
 * The product a run is acting for, sent to mswarm as `x-mswarm-client-product`.
 *
 * This is deliberately separate from the client identity. The identity is the run's
 * tenant slug and stays per-tenant, which is what mswarm attributes usage to. The
 * product is what a self-hosted node can grant wholesale: a node that allowlists
 * `okacam` admits every okacam tenant, so a multi-tenant product does not need one
 * allowlist row per tenant added at provisioning time.
 *
 * mswarm never infers one from the other. A tenant whose slug happens to be `okacam`
 * still reads as a client identity there, not as the product.
 */

/** Same shape mswarm accepts for a product entry: a single slug-like label. */
const CLIENT_PRODUCT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i;

/**
 * Resolves the product for a run.
 *
 * An explicit value from the host's run context wins; otherwise the deployment's
 * `MSWARM_CLIENT_PRODUCT` is used. The env fallback is what lets a product enable this
 * with one deployment variable and no code of its own, since each product runs its own
 * codali instance.
 *
 * Returns undefined rather than throwing on a malformed value: failing to send an
 * optional header must never take a run down. Node access simply falls back to whatever
 * the client identity alone can reach.
 */
export function resolveMswarmClientProduct(explicit?: string | null): string | undefined {
  const candidate = explicit?.trim() || process.env.MSWARM_CLIENT_PRODUCT?.trim();
  if (!candidate || !CLIENT_PRODUCT_PATTERN.test(candidate)) {
    return undefined;
  }
  return candidate.toLowerCase();
}

/**
 * The header pair for a resolved product, or nothing when there is no usable product.
 * Callers spread this next to the client-identity headers.
 */
export function mswarmClientProductHeaders(
  product: string | undefined | null,
): Record<string, string> | undefined {
  const value = resolveMswarmClientProduct(product);
  return value ? { "x-mswarm-client-product": value } : undefined;
}
