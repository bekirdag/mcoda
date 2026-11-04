const knownSecrets = new Set<string>();
const patterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_[A-Za-z0-9]+_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Register credentials when resolved; do not scan or expose unrelated environment values. */
export const registerSecretValue = (value: string): void => {
  if (value.length >= 4) { knownSecrets.add(value); knownSecrets.add(JSON.stringify(value).slice(1, -1)); }
};

export const redactSecretValues = (value: string): string => {
  let output = value;
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) output = output.split(secret).join("[redacted]");
  for (const pattern of patterns) output = output.replace(pattern, "[redacted]");
  return output;
};

/** Hold incomplete credential-shaped words so split chunks cannot expose a prefix or tail. */
export class StreamingSecretRedactor {
  private pending = "";
  private droppingWord = false;
  write(chunk: string): string {
    if (this.droppingWord) {
      const boundary = chunk.search(/[^A-Za-z0-9._~+/=-]/);
      if (boundary < 0) return "";
      chunk = chunk.slice(boundary); this.droppingWord = false;
    }
    this.pending += chunk;
    let cutoff = this.pending.search(/[A-Za-z0-9._~+/=-]*$/);
    const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]*$/i.exec(this.pending);
    if (bearer) cutoff = Math.min(cutoff, bearer.index);
    for (const secret of knownSecrets) {
      // An exact credential may contain spaces/punctuation, unlike a bearer word.
      for (let at = this.pending.indexOf(secret); at >= 0; at = this.pending.indexOf(secret, at + 1)) {
        if (at < cutoff && at + secret.length > cutoff) cutoff = at;
      }
      for (let size = Math.min(secret.length - 1, this.pending.length); size > 0; size--) {
        if (this.pending.endsWith(secret.slice(0, size))) { cutoff = Math.min(cutoff, this.pending.length - size); break; }
      }
    }
    let output = redactSecretValues(this.pending.slice(0, cutoff));
    this.pending = this.pending.slice(cutoff);
    // Never release a truncated prefix; discard an oversized unbroken token.
    const longestCredential = Math.max(0, ...[...knownSecrets].map(secret => secret.length));
    if (this.pending.length > Math.max(65_536, longestCredential)) {
      output += "[redacted oversized token]"; this.pending = ""; this.droppingWord = true;
    }
    return output;
  }
  finish(): string {
    let output = redactSecretValues(this.pending);
    for (const secret of knownSecrets) {
      for (let size = Math.min(secret.length - 1, output.length); size >= 4; size--) {
        if (output.endsWith(secret.slice(0, size))) { output = `${output.slice(0, -size)}[redacted]`; break; }
      }
    }
    this.pending = ""; this.droppingWord = false;
    return output;
  }
}
