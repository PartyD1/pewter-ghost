import { describe, expect, it } from "vitest";
import type { Entity } from "../contracts";
import { CheckpointTracker } from "./checkpoints";

const start = { x: 2, y: 14 };
const entities: Entity[] = [
  { id: "e1", kind: "checkpoint", x: 40, y: 14 },
  { id: "e2", kind: "coin", x: 50, y: 10 },
  { id: "e3", kind: "checkpoint", x: 90, y: 12 },
  { id: "e4", kind: "flag", x: 196, y: 14 },
];

describe("CheckpointTracker", () => {
  it("respawns on the start until a checkpoint is touched", () => {
    const t = new CheckpointTracker(start, entities);
    expect(t.count).toBe(2);
    expect(t.active).toBeUndefined();
    expect(t.respawn).toEqual(start);
  });

  it("respawns on the most recently touched checkpoint", () => {
    const t = new CheckpointTracker(start, entities);
    expect(t.activate("e1")).toBe(true);
    expect(t.respawn).toEqual({ x: 40, y: 14 });
    expect(t.activate("e3")).toBe(true);
    expect(t.respawn).toEqual({ x: 90, y: 12 });
    // Going back to an earlier one moves the respawn back too.
    expect(t.activate("e1")).toBe(true);
    expect(t.respawn).toEqual({ x: 40, y: 14 });
    expect(t.isActive("e1")).toBe(true);
    expect(t.isActive("e3")).toBe(false);
    expect(t.reached).toBe(2);
  });

  it("touching the active checkpoint again or a non-checkpoint changes nothing", () => {
    const t = new CheckpointTracker(start, entities);
    t.activate("e1");
    expect(t.activate("e1")).toBe(false);
    expect(t.activate("e2")).toBe(false);
    expect(t.activate("nope")).toBe(false);
    expect(t.active).toBe("e1");
    expect(t.reached).toBe(1);
  });

  it("returns copies, so callers cannot move the start or a checkpoint", () => {
    const t = new CheckpointTracker(start, entities);
    t.respawn.x = 99;
    expect(t.respawn).toEqual(start);
  });
});
