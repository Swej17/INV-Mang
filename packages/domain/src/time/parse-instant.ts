/**
 * Parse a timestamp to epoch milliseconds, refusing anything `Date.parse`
 * cannot make sense of.
 *
 * `Date.parse` returns NaN on bad input instead of throwing, and NaN answers
 * every comparison false -- `NaN > threshold` and `NaN <= threshold` are
 * BOTH false. A staleness check, an expiry check, or a date-range filter
 * built directly on `Date.parse` therefore reports the safe-looking answer
 * (not stale, not expired, not in range) for precisely the input that should
 * have failed loudest. Rejecting at the boundary is the one direction that
 * cannot silently invert.
 */
export function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} is not a valid instant: ${value}`);
  }
  return parsed;
}
