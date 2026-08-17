import { describe, expect, it } from "vitest";

import { selectFifoLots, type Lot } from "./select-fifo.js";

const OLDER = "0199a400-0000-7000-8000-000000000001";
const NEWER = "0199a400-0000-7000-8000-000000000002";
const NEWEST = "0199a400-0000-7000-8000-000000000003";

function lot(overrides: Partial<Lot> & { lotId: string }): Lot {
  return {
    receivedDate: "2026-08-01",
    bestByDate: null,
    remaining: "10",
    ...overrides,
  };
}

describe("selectFifoLots", () => {
  it("selects received date then best-by date deterministically", () => {
    const lots = [
      lot({ lotId: NEWER, receivedDate: "2026-08-10" }),
      lot({ lotId: OLDER, receivedDate: "2026-08-01" }),
    ];
    expect(selectFifoLots(lots, "12").map((x) => x.lotId)).toEqual([OLDER, NEWER]);
  });

  it("draws only what is needed from the last lot", () => {
    const lots = [
      lot({ lotId: OLDER, receivedDate: "2026-08-01", remaining: "10" }),
      lot({ lotId: NEWER, receivedDate: "2026-08-10", remaining: "10" }),
    ];
    const picks = selectFifoLots(lots, "12");
    expect(picks.map((p) => p.quantity)).toEqual(["10", "2"]);
  });

  it("prefers an earlier best-by date when received dates tie", () => {
    // Same delivery, different shelf life: use the one that expires first.
    const lots = [
      lot({ lotId: NEWER, receivedDate: "2026-08-01", bestByDate: "2027-01-01" }),
      lot({ lotId: OLDER, receivedDate: "2026-08-01", bestByDate: "2026-10-01" }),
    ];
    expect(selectFifoLots(lots, "5").map((x) => x.lotId)).toEqual([OLDER]);
  });

  it("treats a lot with no best-by date as last among equal receipts", () => {
    const lots = [
      lot({ lotId: NEWER, receivedDate: "2026-08-01", bestByDate: null }),
      lot({ lotId: OLDER, receivedDate: "2026-08-01", bestByDate: "2026-12-01" }),
    ];
    expect(selectFifoLots(lots, "5").map((x) => x.lotId)).toEqual([OLDER]);
  });

  it("falls back to lot id so selection is reproducible", () => {
    // Identical on every business axis; the same input must select the same
    // lots every time or two dry runs would disagree.
    const lots = [
      lot({ lotId: NEWEST, receivedDate: "2026-08-01", bestByDate: "2026-12-01" }),
      lot({ lotId: OLDER, receivedDate: "2026-08-01", bestByDate: "2026-12-01" }),
    ];
    expect(selectFifoLots(lots, "5").map((x) => x.lotId)).toEqual([OLDER]);
    expect(selectFifoLots([...lots].reverse(), "5").map((x) => x.lotId)).toEqual([OLDER]);
  });

  it("skips exhausted lots entirely", () => {
    const lots = [
      lot({ lotId: OLDER, receivedDate: "2026-08-01", remaining: "0" }),
      lot({ lotId: NEWER, receivedDate: "2026-08-10", remaining: "10" }),
    ];
    expect(selectFifoLots(lots, "5").map((x) => x.lotId)).toEqual([NEWER]);
  });

  it("throws when the lots cannot cover the requirement", () => {
    // Silently under-selecting would let a batch consume less than the recipe
    // demands and still report success.
    const lots = [lot({ lotId: OLDER, remaining: "3" })];
    expect(() => selectFifoLots(lots, "10")).toThrow("insufficient lot quantity");
  });

  it("returns nothing for a zero requirement", () => {
    expect(selectFifoLots([lot({ lotId: OLDER })], "0")).toEqual([]);
  });

  it("preserves exact decimal quantities", () => {
    const lots = [
      lot({ lotId: OLDER, receivedDate: "2026-08-01", remaining: "4535.9237" }),
      lot({ lotId: NEWER, receivedDate: "2026-08-10", remaining: "4535.9237" }),
    ];
    const picks = selectFifoLots(lots, "4535.9238");
    expect(picks[0]!.quantity).toBe("4535.9237");
    expect(picks[1]!.quantity).toBe("0.0001");
  });

  it("never returns a negative or zero draw", () => {
    const lots = [
      lot({ lotId: OLDER, receivedDate: "2026-08-01", remaining: "10" }),
      lot({ lotId: NEWER, receivedDate: "2026-08-10", remaining: "10" }),
    ];
    // Exactly the first lot: the second must not appear with a zero draw.
    const picks = selectFifoLots(lots, "10");
    expect(picks).toHaveLength(1);
    expect(picks[0]!.quantity).toBe("10");
  });

  it("rejects a non-canonical requirement", () => {
    expect(() => selectFifoLots([lot({ lotId: OLDER })], "1e1")).toThrow("invalid quantity");
  });
});
