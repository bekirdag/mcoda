/** Recognize only direct requests to add/extend tests. This is a conservative
 * extra evidence check, not a natural-language requirement parser. The full
 * request still goes to independent review. Existing-test execution alone is
 * not evidence that the agent added requested regression coverage. */
export const requestsAddedTests = (requirements: readonly { description: string }[]): boolean => requirements.some(({ description }) =>
  /(?:^\s*(?:[-*+]\s+|\d+[.)]\s+)?|[.!?;:,]\s*|\band\s+)(?:please\s+)?(?:add|write|create|extend|expand)\s+(?:(?:a|the|some|new|more|additional|meaningful|public|focused|unit|integration|regression|automated|end-to-end|e2e)\s+)*(?:tests?\b|test\s+(?:cases|coverage)\b)/im.test(description));

export const isTestSourcePath = (file: string): boolean => {
  const normalized = file.replace(/\\/g, '/');
  if (!/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|swift|cs|c|cpp|sh)$/.test(normalized)) return false;
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rs)$|(?:Test|Tests|Spec)\.(?:java|kt|cs|php|swift)$/.test(normalized);
};

export const assertRequestedTestEvidence = (requirements: readonly { description: string }[], changedPaths: readonly string[], currentHashes: Record<string, string>, codeChanged: boolean): void => {
  if (codeChanged && requestsAddedTests(requirements) && !changedPaths.some(file => isTestSourcePath(file) && /^[a-f0-9]{64}$/.test(currentHashes[file] ?? ''))) {
    throw new Error('This task explicitly requires added or extended tests, but no test source has changed from the workspace baseline. Running an existing test does not satisfy that requirement. Add meaningful coverage, rerun the checks, then request verification again.');
  }
};
