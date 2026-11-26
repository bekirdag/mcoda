import { numberValues, type AnswerCheck, type FigureResult } from "./FigureCheck.js";
import type { AnswerEdit } from "./AnswerEdits.js";

/** Guards around a consistency audit, decided from calculator results rather
 * than from the audit's own judgement. In cycle 7 the audit doubled figures
 * the calculator had just confirmed (243 cartridges a year became 486) and
 * "corrected" a right figure into a tenfold error, and nothing checked its
 * output. */

const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const contains = (values: number[], value: number): boolean => values.some(other => same(other, value));
/** Kept, allowing for the rounding of a restated value (233.28 written as 233.3). */
const keeps = (values: number[], value: number): boolean => values.some(other => Math.abs(other - value) <= 0.01 * Math.abs(value));
/** Small whole numbers occur everywhere; protecting them would refuse ordinary edits. */
const distinctive = (value: number): boolean => !(Number.isInteger(value) && Math.abs(value) < 10);

/** Figures in a mismatch the audit should resolve: not those whose expression
 * uses numbers the draft and request never state. */
export const flaggedFigures = (check: AnswerCheck | undefined): FigureResult[] =>
  (check?.figures ?? []).filter(figure => !figure.error && !figure.matches && figure.suspect !== "inputs_not_in_text");

/** Values the calculator confirmed and the text states, which an edit may not
 * change. A confirmed figure that uses a flagged figure as an input is not
 * protected: correcting the input must be able to carry through. */
export const protectedFigures = (check: AnswerCheck | undefined, text: string): FigureResult[] => {
  const flagged = flaggedFigures(check).map(figure => figure.stated), stated = numberValues(text);
  return (check?.figures ?? []).filter(figure => figure.matches && !figure.error && figure.computed !== undefined && distinctive(figure.stated)
    && contains(stated, figure.stated) && !numberValues(figure.expression.replace(/\[[^\]]*\]/gu, " ")).some(input => contains(flagged, input)));
};

/** Why an edit must be refused: it removes a protected value from the passage it replaces. */
export const editChangesProtected = (edit: AnswerEdit, guarded: FigureResult[]): string | undefined => {
  const before = numberValues(edit.find), after = numberValues(edit.replace);
  const hit = guarded.find(figure => contains(before, figure.stated) && !keeps(after, figure.stated));
  return hit ? `confirmed_figure:${hit.stated}` : undefined;
};

/** Protected values that a full rewrite dropped. */
export const droppedProtected = (guarded: FigureResult[], revised: string): number[] => {
  const after = numberValues(revised);
  return guarded.filter(figure => !keeps(after, figure.stated)).map(figure => figure.stated);
};

/** Failures in the re-check of a revised text that the revision introduced: a
 * mismatched figure whose stated value the previous text did not contain, or a
 * target the previous check found met (or did not list) and the new one finds missed. */
export const introducedFailures = (after: AnswerCheck, previousText: string, previous: AnswerCheck | undefined): { values: number[]; targets: string[] } => {
  const earlier = numberValues(previousText);
  const values = flaggedFigures(after).map(figure => figure.stated).filter(value => !contains(earlier, value));
  const missedBefore = new Set((previous?.targets ?? []).filter(target => !target.met && !target.error).map(target => target.requirement.trim().toLowerCase()));
  const targets = after.targets.filter(target => !target.met && !target.error && !missedBefore.has(target.requirement.trim().toLowerCase()))
    .filter(target => target.achievedClaim === undefined || !previousText.includes(target.achievedClaim)).map(target => target.requirement);
  return { values, targets };
};

/** The edits to undo for introduced failures: those whose new text carries an introduced value or achieved claim. */
export const editsToRevert = (edits: AnswerEdit[], failures: { values: number[]; targets: string[] }, after: AnswerCheck): AnswerEdit[] => {
  const claims = after.targets.filter(target => failures.targets.includes(target.requirement)).map(target => target.achievedClaim ?? "").filter(Boolean);
  return edits.filter(edit => {
    const added = numberValues(edit.replace).filter(value => !contains(numberValues(edit.find), value));
    return failures.values.some(value => contains(added, value)) || claims.some(claim => edit.replace.includes(claim) && !edit.find.includes(claim));
  });
};

/** Open problems a check hands to the audit: flagged figures, missed targets, conflicts. */
export const openIssues = (check: AnswerCheck | undefined): number =>
  flaggedFigures(check).length + (check?.targets ?? []).filter(target => !target.met && !target.error).length + (check?.conflicts.length ?? 0);
