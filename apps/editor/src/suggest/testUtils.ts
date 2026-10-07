/**
 * Builders shared by this module's tests (and usable by other modules' tests:
 * the G-18 completeness checker, ghost-layer tests). Not imported by app code.
 */
import {
  AUTHOR,
  TILE,
  type Author,
  type EntityKind,
  type PlacementEvent,
  type Suggestion,
  type VerifiedSuggestion,
} from "../contracts";
import { DEFAULT_CONFIG, type GhostConfig } from "./config";
import { asVerified } from "./verified";

let seq = 0;

export function makeSuggestion(over: Partial<Suggestion> = {}): VerifiedSuggestion {
  seq++;
  const adds = over.adds ?? [
    { x: 10, y: 15, tile: TILE.BLOCK },
    { x: 11, y: 15, tile: TILE.BLOCK },
  ];
  const first = adds[0] ?? over.removes?.[0] ?? over.entities?.[0] ?? { x: 0, y: 0 };
  return asVerified({
    id: over.id ?? `s${seq}`,
    kind: "finish",
    adds,
    removes: [],
    entities: [],
    confidence: 0.9,
    label: "staircase",
    anchor: { x: first.x, y: first.y },
    requestHash: `h${seq}`,
    filler: "stub",
    latencyMs: 0,
    mode: "auto",
    verified: true,
    attempts: 1,
    ...over,
  });
}

let strokeSeq = 0;
export const newStroke = () => `k${++strokeSeq}`;

export function paint(
  t: number,
  x: number,
  y: number,
  tile: PlacementEvent["tile"] = TILE.BLOCK,
  stroke = newStroke(),
  author: Author = AUTHOR.PERSON,
): PlacementEvent {
  return { t, x, y, tile, author, stroke, tool: "paint" };
}

export function erase(t: number, x: number, y: number, stroke = newStroke()): PlacementEvent {
  return { t, x, y, tile: 0, author: AUTHOR.PERSON, stroke, tool: "erase" };
}

export function placeEntity(
  t: number,
  x: number,
  y: number,
  kind: EntityKind,
  stroke = newStroke(),
): PlacementEvent {
  return { t, x, y, tile: `entity:${kind}`, author: AUTHOR.PERSON, stroke, tool: "paint" };
}

export function testConfig(over: Partial<GhostConfig> = {}): GhostConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...over };
}
