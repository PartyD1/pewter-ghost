/**
 * The "verified" brand.
 *
 * The suggestion manager only accepts `VerifiedSuggestion`, so an unverified
 * suggestion cannot reach the screen by accident. The brand is applied in one
 * place: the playability verifier (G-15/G-16) calls `asVerified` after a
 * suggestion passed shape, rules and agent checks.
 *
 * DO NOT call `asVerified` anywhere else. Fillers, tests of other modules and
 * UI code must go through the verifier. (Unit tests of this module and of the
 * manager are the only other legitimate callers.)
 */
import type { Suggestion, VerifiedSuggestion } from "../contracts";

/**
 * Brand a suggestion as verified. FOR THE VERIFIER ONLY (see module comment).
 * Returns a shallow copy; the input is not mutated.
 */
export function asVerified(s: Suggestion): VerifiedSuggestion {
  return { ...s, verified: true, __verified: true };
}

/** Runtime check of the brand (the type alone can be cast around). */
export function isVerified(s: Suggestion | null | undefined): s is VerifiedSuggestion {
  return (
    !!s &&
    s.verified === true &&
    (s as Partial<VerifiedSuggestion>).__verified === true
  );
}
