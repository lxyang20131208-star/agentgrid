// Structural verification of a job result.
//
// When a worker returns a result the coordinator runs cheap, deterministic
// checks on it — no API keys, no model calls. These cannot judge whether the
// answer is *correct* (that is what the buyer acceptance window and disputes
// are for), but they do catch results that are plainly unusable: empty
// output, raw error dumps, absurd sizes.

import type { JobFile, ResultCheck } from './types.js';

/** Largest plausible result text, in characters. */
const MAX_RESULT_CHARS = 5_000_000;

/** Patterns that strongly suggest the "result" is actually an error dump. */
const ERROR_PATTERNS: RegExp[] = [
  /^\s*error:/i,
  /^\s*\[error\]/i,
  /^\s*traceback \(most recent call last\):/i,
  /^\s*uncaught (exception|error)/i,
  /^\s*fatal:/i,
];

/** True when the result carries something the buyer can actually use. */
export function isResultUsable(
  resultText: string,
  outputFiles: JobFile[],
): boolean {
  return resultText.trim().length > 0 || outputFiles.length > 0;
}

/**
 * Run structural checks on a job result. A failing check does not by itself
 * fail the job — the coordinator decides — but every reason is recorded so a
 * buyer (and any later dispute) can see why a result was questioned.
 */
export function checkResult(
  resultText: string,
  outputFiles: JobFile[],
): ResultCheck {
  const reasons: string[] = [];

  if (!isResultUsable(resultText, outputFiles)) {
    reasons.push('result is empty and produced no output files');
  }
  if (resultText.length > MAX_RESULT_CHARS) {
    reasons.push(`result text is implausibly large (${resultText.length} chars)`);
  }
  if (ERROR_PATTERNS.some((p) => p.test(resultText))) {
    reasons.push('result text looks like an error message, not an answer');
  }
  for (const file of outputFiles) {
    if (file.content.length > MAX_RESULT_CHARS) {
      reasons.push(`output file ${file.path} is implausibly large`);
      break;
    }
  }

  return { ok: reasons.length === 0, reasons };
}
