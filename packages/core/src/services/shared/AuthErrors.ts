const AUTH_ERROR_PATTERNS = [
  /auth_error/i,
  /usage_limit_reached/i,
  /too many requests/i,
  /http\s*429/i,
  /rate limit/i,
  /usage limit/i,
  /invalid[_\s-]*api[_\s-]*key/i,
  /no openai api key/i,
  /insufficient[_\s-]*quota/i,
];

export const AUTH_ERROR_REASON = "auth_error";

export const isAuthErrorMessage = (message?: string | null): boolean => {
  if (!message) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};
