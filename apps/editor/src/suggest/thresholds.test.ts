import { describe, expect, it, vi } from "vitest";
import { SessionThresholds } from "./thresholds";
import { testConfig } from "./testUtils";

const make = (over = {}) => {
  const cfg = testConfig(over);
  const onChange = vi.fn();
  return { cfg, t: new SessionThresholds(() => cfg, onChange), onChange };
};

describe("SessionThresholds", () => {
  it("starts at config.showNowAbove", () => {
    expect(make().t.showNowAbove).toBe(0.75);
  });

  it("raises by one step after two drawn-over dismissals in a row", () => {
    const { t, onChange } = make();
    expect(t.record("drawn-over")).toBeNull();
    expect(t.showNowAbove).toBe(0.75);
    expect(t.record("drawn-over")).toEqual({ from: 0.75, to: 0.8, reason: "drawn-over-run" });
    expect(t.showNowAbove).toBe(0.8);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("lowers by one step after two accepts (full or partial) in a row", () => {
    const { t } = make();
    t.record("accepted");
    t.record("partial");
    expect(t.showNowAbove).toBe(0.7);
  });

  it("restarts the run after a step (four in a row = two steps)", () => {
    const { t } = make();
    for (let i = 0; i < 3; i++) t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.8);
    t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.85);
  });

  it("an accept breaks a drawn-over run and vice versa", () => {
    const { t } = make();
    t.record("drawn-over");
    t.record("accepted");
    t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.75);
    t.record("accepted");
    t.record("drawn-over");
    t.record("accepted");
    expect(t.showNowAbove).toBe(0.75);
  });

  it("Esc breaks both runs; replaced/timeout/pending are neutral", () => {
    const { t } = make();
    t.record("drawn-over");
    t.record("esc");
    t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.75);
    t.record("replaced");
    t.record("timeout");
    t.record("pending");
    t.record("drawn-over"); // run was 1, neutral outcomes kept it, now 2
    expect(t.showNowAbove).toBe(0.8);
  });

  it("is bounded to [0.5, 0.95]", () => {
    const { t } = make();
    for (let i = 0; i < 40; i++) t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.95);
    for (let i = 0; i < 80; i++) t.record("accepted");
    expect(t.showNowAbove).toBe(0.5);
  });

  it("does not report a change when pinned at a bound", () => {
    const { t, onChange } = make({ showNowAbove: 0.95 });
    t.record("drawn-over");
    expect(t.record("drawn-over")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reset returns to the base and clears runs", () => {
    const { t, onChange } = make();
    t.record("drawn-over");
    t.record("drawn-over");
    t.record("drawn-over");
    expect(t.reset()).toEqual({ from: 0.8, to: 0.75, reason: "reset" });
    expect(t.runs).toEqual({ drawnOver: 0, accept: 0 });
    t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.75);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(t.reset()).toBeNull();
  });

  it("follows a config override of the base, keeping the adapted offset", () => {
    const { cfg, t } = make();
    t.record("drawn-over");
    t.record("drawn-over");
    cfg.showNowAbove = 0.6;
    expect(t.showNowAbove).toBe(0.65);
  });

  it("does nothing when adaptation is disabled", () => {
    const { t, onChange } = make({ adaptThresholds: false, showNowAbove: 0.42 });
    for (let i = 0; i < 6; i++) t.record("drawn-over");
    expect(t.showNowAbove).toBe(0.42);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("honours custom step, bounds and run length", () => {
    const { t } = make({ adaptStep: 0.1, adaptMin: 0.6, adaptMax: 0.8, adaptRun: 3 });
    t.record("accepted");
    t.record("accepted");
    expect(t.showNowAbove).toBe(0.75);
    t.record("accepted");
    expect(t.showNowAbove).toBe(0.65);
    for (let i = 0; i < 3; i++) t.record("accepted");
    expect(t.showNowAbove).toBe(0.6);
  });
});
