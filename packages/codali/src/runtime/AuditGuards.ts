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
 * uses numbers the draft and request never state. A difference of exactly a
 * unit factor stays flagged, marked as a possible slip: it may be the
 * expression's slip or a real unit error in the draft, and the audit judges which. */
export const flaggedFigures = (check: AnswerCheck | undefined): FigureResult[] =>
  (check?.figures ?? []).filter(figure => !figure.error && !figure.matches && figure.suspect !== "inputs_not_in_text");

const inputsOf = (figure: FigureResult): number[] => numberValues(figure.expression.replace(/\[[^\]]*\]/gu, " "));

/** Values the calculator confirmed and the text states, which an edit may not
 * change. A confirmed figure that uses a flagged figure as an input is not
 * protected: correcting the input must be able to carry through. */
export const protectedFigures = (check: AnswerCheck | undefined, text: string): FigureResult[] => {
  const flagged = flaggedFigures(check).map(figure => figure.stated), stated = numberValues(text);
  return (check?.figures ?? []).filter(figure => figure.matches && !figure.error && figure.computed !== undefined && distinctive(figure.stated)
    && contains(stated, figure.stated) && !inputsOf(figure).some(input => contains(flagged, input)));
};

/** The protected figures that stay protected under a set of edits. When an
 * edit changes an input of a protected figure (3 shifts become 4), that figure
 * must be free to change with it, and so must every figure built on it, or the
 * answer is left saying 4 x 81 = 243. The new values are then judged by the
 * re-check, not by the protection. */
export const stillProtected = (guarded: FigureResult[], edits: AnswerEdit[]): FigureResult[] => {
  const removed = edits.flatMap(edit => { const after = numberValues(edit.replace); return numberValues(edit.find).filter(value => !keeps(after, value)); });
  const freed = new Set<FigureResult>();
  // Inputs changed directly (not themselves protected results), then whatever depends on a freed result.
  let changed = removed.filter(value => !guarded.some(figure => same(figure.stated, value)));
  while (changed.length) {
    const next = guarded.filter(figure => !freed.has(figure) && inputsOf(figure).some(input => contains(changed, input)));
    for (const figure of next) freed.add(figure);
    changed = next.map(figure => figure.stated).filter(value => contains(removed, value));
  }
  return guarded.filter(figure => !freed.has(figure));
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
 * mismatched figure whose stated value the previous text did not contain or
 * the previous check had confirmed (an input changed, its result did not), or
 * a target the previous check found met (or did not list) and the new one
 * finds missed. `inputs` are the input numbers of those figures. */
export const introducedFailures = (after: AnswerCheck, previousText: string, previous: AnswerCheck | undefined): { values: number[]; inputs: number[]; targets: string[] } => {
  const earlier = numberValues(previousText);
  const confirmed = (previous?.figures ?? []).filter(figure => figure.matches && !figure.error && figure.computed !== undefined).map(figure => figure.stated);
  const broken = flaggedFigures(after).filter(figure => !contains(earlier, figure.stated) || contains(confirmed, figure.stated));
  const missedBefore = new Set((previous?.targets ?? []).filter(target => !target.met && !target.error).map(target => target.requirement.trim().toLowerCase()));
  const targets = after.targets.filter(target => !target.met && !target.error && !missedBefore.has(target.requirement.trim().toLowerCase()))
    .filter(target => target.achievedClaim === undefined || !previousText.includes(target.achievedClaim)).map(target => target.requirement);
  return { values: broken.map(figure => figure.stated), inputs: broken.flatMap(inputsOf), targets };
};

/** The edits to undo for introduced failures: those whose new text carries an
 * introduced value, an input of a newly broken figure, or an achieved claim. */
export const editsToRevert = (edits: AnswerEdit[], failures: { values: number[]; inputs?: number[]; targets: string[] }, after: AnswerCheck): AnswerEdit[] => {
  const claims = after.targets.filter(target => failures.targets.includes(target.requirement)).map(target => target.achievedClaim ?? "").filter(Boolean);
  const suspects = [...failures.values, ...(failures.inputs ?? [])];
  return edits.filter(edit => {
    const added = numberValues(edit.replace).filter(value => !contains(numberValues(edit.find), value));
    return suspects.some(value => contains(added, value)) || claims.some(claim => edit.replace.includes(claim) && !edit.find.includes(claim));
  });
};

/** Open problems a check hands to the audit: flagged figures, missed targets, conflicts. */
export const openIssues = (check: AnswerCheck | undefined): number =>
  flaggedFigures(check).length + (check?.targets ?? []).filter(target => !target.met && !target.error).length + (check?.conflicts.length ?? 0);
