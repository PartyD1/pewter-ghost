/**
 * Verification (G-15, G-16, G-23, G-26): nothing unverified reaches the ghost layer.
 *
 *   validateSuggestion  — shape, repeat, measure bands, collectable/enemy rules
 *   verifyPlayability   — rule check then the playtest agent over the section
 *   verifyWithSendBack  — the pipeline; the ONLY producer of VerifiedSuggestion
 *   Patrol / proposeRepair / verifyPatrolFix — whole-level patrol and its Fix
 */
export * from "./merge";
export * from "./validate";
export * from "./playability";
export * from "./pipeline";
export * from "./patrol";
