/** Bounded diagnostic context, never a substitute for the original receipt or
 * its exit status. Preserve the failing region when passing checks fill the
 * beginning of a long test log. */
export function validationOutputExcerpt(output: string, maximum = 2400): string {
  if (!Number.isInteger(maximum) || maximum < 600 || maximum > 8000) throw new RangeError("Invalid validation excerpt bound");
  if (output.length <= maximum) return output;
  output = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  if (output.length <= maximum) return output;
  const marker = "\n[... output omitted from this excerpt ...]\n";
  const strong = /^(?:\s*not ok\s+\d|\s*FAIL(?:ED)?\s|\s*=+\s*FAILURES\s*=+|\s*error\[E\d+\]|.*: error (?:TS\d+|[A-Z]\d+):?)/m;
  const fallback = /^(?:\s*(?:AssertionError|TypeError|Error):|.*panicked at)/m;
  const failure = strong.exec(output) ?? fallback.exec(output);
  if (!failure) {
    const available = maximum - marker.length; const head = Math.floor(available * 0.55);
    return output.slice(0, head) + marker + output.slice(-(available - head));
  }
  const headSize = Math.min(180, Math.floor(maximum * 0.15));
  const tailSize = Math.min(400, Math.floor(maximum * 0.2));
  const windowSize = maximum - headSize - tailSize - marker.length * 2;
  const start = Math.max(0, failure.index - Math.min(80, Math.floor(windowSize * 0.15)));
  const end = Math.min(output.length, start + windowSize);
  // Regions cannot overlap. Keeping an unused few characters is preferable to
  // duplicating log content or trimming the failure after assembly.
  const head = output.slice(0, Math.min(headSize, start));
  const tailStart = Math.max(end, output.length - tailSize);
  const tail = output.slice(tailStart);
  return head + (start > head.length ? marker : "") + output.slice(start, end) + (tailStart > end ? marker : "") + tail;
}
