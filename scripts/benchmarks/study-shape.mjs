// Only app builds may run longer. The deadline is part of the case so each arm
// sees it from the start, rather than being killed by an outside timer.
export const MAX_NON_APP_DEADLINE_MS = 30 * 60 * 1000;

// Validate a prospective cohort without silently changing historical defaults.
export function studyLabels(study) {
  const labels = study.comparisonArms === undefined ? ['before', 'after', 'raw_tools'] : study.comparisonArms;
  if (!Array.isArray(labels) || ![['after','raw_tools'],['before','after','raw_tools']].some(allowed => JSON.stringify(allowed) === JSON.stringify(labels))) {
    throw Error('Expected current Codali and raw tools, or an explicit historical three-arm cohort');
  }
  return [...labels];
}

export function validateStudyShape(study, cases) {
  const count = study.expectedCases === undefined ? 52 : study.expectedCases;
  const builds = study.expectedBuilds === undefined ? 2 : study.expectedBuilds;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(builds) || builds < 0 || builds > count) {
    throw Error('Invalid expected study counts');
  }
  if (!Array.isArray(cases) || cases.length !== count || new Set(cases.map(c => c.id)).size !== count
    || cases.filter(c => c.comparison === 'implementation').length !== builds) {
    throw Error(`Expected ${count} unique cases including ${builds} builds`);
  }
  const overLimit = cases.find(c => c.comparison !== 'implementation' && c.execution?.deadlineMs > MAX_NON_APP_DEADLINE_MS);
  if (overLimit) throw Error(`Case ${overLimit.id} exceeds the 30-minute limit for non-app requests`);
}
