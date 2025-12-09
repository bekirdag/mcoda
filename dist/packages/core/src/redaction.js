import crypto from "node:crypto";
const DEFAULT_MASK = "[REDACTED]";
const SECRET_MASK_PREFIX = "***SECRET:";
const secretRegistry = [];
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeLabel = (label) => {
    const trimmed = (label ?? "").trim();
    return trimmed.length > 0 ? trimmed.replace(/\s+/g, "_") : "secret";
};
const normalizeRules = (rules) => {
    if (!rules || rules.length === 0)
        return defaultRedactionRules;
    return rules;
};
// Default rules focus on obvious secret shapes (API keys, bearer tokens, headers, generic token assignments).
export const defaultRedactionRules = [
    { pattern: /(sk-[a-z0-9]{16,})/gi, replacement: "[REDACTED_API_KEY]", description: "Generic sk-* API keys" },
    { pattern: /(bearer\s+)[a-z0-9._-]{8,}/gi, replacement: "$1[REDACTED_TOKEN]", description: "Bearer tokens" },
    { pattern: /(authorization:\s*)([^\n]+)/gi, replacement: "$1[REDACTED_AUTH]", description: "Authorization headers" },
    { pattern: /(api[_-]?key\s*[:=]\s*)(['"]?[a-z0-9\-_.]{8,}['"]?)/gi, replacement: "$1[REDACTED_API_KEY]", description: "apiKey assignments" },
    { pattern: /(token\s*[:=]\s*)(['"]?[a-z0-9\-_.]{8,}['"]?)/gi, replacement: "$1[REDACTED_TOKEN]", description: "token assignments" },
    { pattern: /(secret\s*[:=]\s*)(['"]?[a-z0-9\-_.]{6,}['"]?)/gi, replacement: "$1[REDACTED_SECRET]", description: "secret assignments" },
];
export const registerSecret = (value, label) => {
    if (!value)
        return;
    const trimmed = value.trim();
    if (!trimmed)
        return;
    const fingerprint = crypto.createHash("sha256").update(trimmed).digest("hex");
    const exists = secretRegistry.some((entry) => entry.fingerprint === fingerprint);
    if (exists)
        return;
    secretRegistry.push({ label: normalizeLabel(label), value: trimmed, fingerprint });
};
export const registerSecrets = (entries = []) => {
    entries.forEach((entry) => registerSecret(entry.value, entry.label));
};
export const clearRegisteredSecrets = () => {
    secretRegistry.splice(0, secretRegistry.length);
};
const applySecretRedactions = (input) => {
    let output = input;
    for (const entry of secretRegistry) {
        const mask = `${SECRET_MASK_PREFIX}${entry.label}***`;
        const valuePattern = new RegExp(escapeForRegex(entry.value), "g");
        const fingerprintPattern = new RegExp(escapeForRegex(entry.fingerprint), "g");
        output = output.replace(valuePattern, mask).replace(fingerprintPattern, mask);
    }
    return output;
};
export const redactText = (input, rules = defaultRedactionRules) => {
    const normalizedRules = normalizeRules(rules);
    const withSecrets = applySecretRedactions(input);
    return normalizedRules.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement ?? DEFAULT_MASK), withSecrets);
};
export const redactValue = (value, rules = defaultRedactionRules) => {
    if (typeof value === "string") {
        return redactText(value, rules);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, rules));
    }
    if (value && typeof value === "object") {
        const clone = {};
        for (const [key, val] of Object.entries(value)) {
            clone[key] = redactValue(val, rules);
        }
        return clone;
    }
    return value;
};
export const withRedaction = (raw, rules = defaultRedactionRules) => ({
    raw,
    redacted: redactText(raw, rules),
});
