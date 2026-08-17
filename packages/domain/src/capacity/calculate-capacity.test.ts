import { describe, expect, it } from "vitest";

import { convertQuantity } from "../units/convert.js";
import { calculateCapacity, type CapacityInput, type RecipeComponent } from "./calculate-capacity.js";

const WAX = "0199a200-0000-7000-8000-000000000001";
const FRAGRANCE = "0199a200-0000-7000-8000-000000000002";
const VESSEL = "0199a200-0000-7000-8000-000000000003";
const WICK = "0199a200-0000-7000-8000-000000000007";
const BOX = "0199a200-0000-7000-8000-000000000008";

const NO_LOSS = { mode: "NONE" } as const;

/**
 * Grams for an ounce amount, via the domain's tested converter.
 * Doing this with Number arithmetic would make the fixtures inexact — the
 * precise failure this package exists to prevent.
 */
function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

function component(overrides: Partial<RecipeComponent> & { itemId: string }): RecipeComponent {
  return {
    perUnitBase: "1",
    dependencyClass: "PRODUCTION_CRITICAL",
    loss: NO_LOSS,
    countable: true,
    ...overrides,
  };
}

/** The real 17 oz recipe: 15.7 oz wax + 1.3 oz fragrance + five countables. */
function currentCandle(available: Record<string, string>, overrides: Partial<CapacityInput> = {}): CapacityInput {
  return {
    recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
    components: [
      component({ itemId: WAX, perUnitBase: oz("15.7"), countable: false }),
      component({ itemId: FRAGRANCE, perUnitBase: oz("1.3"), countable: false }),
      component({ itemId: VESSEL }),
      component({ itemId: WICK }),
    ],
    availableByItem: available,
    lossEnabled: true,
    ...overrides,
  };
}

describe("calculateCapacity", () => {
  it("finds wax as the limit for the current 17 oz recipe", () => {
    // 157 oz of wax makes exactly 10 candles; everything else allows more.
    const result = calculateCapacity(
      currentCandle({
        [WAX]: oz("157"),
        [FRAGRANCE]: oz("26"),
        [VESSEL]: "20",
        [WICK]: "20",
      }),
    );
    expect(result.adjustedUnits).toBe(10);
    expect(result.limitingItemIds).toEqual([WAX]);
  });

  it("reports zero capacity when a production-critical component is absent", () => {
    const result = calculateCapacity(
      currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "0", [WICK]: "20" }),
    );
    expect(result.adjustedUnits).toBe(0);
    expect(result.limitingItemIds).toEqual([VESSEL]);
  });

  it("returns every tied component when several limit equally", () => {
    const result = calculateCapacity(
      currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("13"), [VESSEL]: "5", [WICK]: "5" }),
    );
    expect(result.adjustedUnits).toBe(5);
    expect([...result.limitingItemIds].sort()).toEqual([VESSEL, WICK].sort());
  });

  it("ignores fulfillment-critical components entirely", () => {
    // A missing shipping box must never reduce how many candles can be made.
    const result = calculateCapacity(
      currentCandle(
        { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20", [BOX]: "0" },
        {
          components: [
            component({ itemId: WAX, perUnitBase: oz("15.7"), countable: false }),
            component({ itemId: FRAGRANCE, perUnitBase: oz("1.3"), countable: false }),
            component({ itemId: VESSEL }),
            component({ itemId: WICK }),
            component({ itemId: BOX, dependencyClass: "FULFILLMENT_CRITICAL" }),
          ],
        },
      ),
    );
    expect(result.adjustedUnits).toBe(10);
    expect(result.limitingItemIds).toEqual([WAX]);
  });

  it("ignores advisory components entirely", () => {
    const result = calculateCapacity(
      currentCandle(
        { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20", [BOX]: "0" },
        {
          components: [
            component({ itemId: WAX, perUnitBase: oz("15.7"), countable: false }),
            component({ itemId: VESSEL }),
            component({ itemId: BOX, dependencyClass: "ADVISORY" }),
          ],
        },
      ),
    );
    expect(result.adjustedUnits).toBe(10);
  });

  describe("protected stock", () => {
    it("reduces adjusted capacity but never theoretical", () => {
      const input = currentCandle(
        { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
        { protectedByItem: { [WAX]: oz("78.5") } },
      );
      const result = calculateCapacity(input);
      expect(result.theoreticalUnits).toBe(10);
      expect(result.adjustedUnits).toBe(5);
    });

    it("never increases capacity", () => {
      const base = calculateCapacity(
        currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" }),
      );
      const withProtection = calculateCapacity(
        currentCandle(
          { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          { protectedByItem: { [WAX]: oz("28.349523125") } },
        ),
      );
      expect(withProtection.adjustedUnits).toBeLessThanOrEqual(base.adjustedUnits);
    });
  });

  describe("process loss", () => {
    it("applies percentage loss per unit", () => {
      // 10% loss on wax: 157 oz supports 9 candles, not 10.
      const result = calculateCapacity(
        currentCandle(
          { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          {
            components: [
              component({
                itemId: WAX,
                perUnitBase: oz("15.7"),
                countable: false,
                loss: { mode: "PERCENT_PER_UNIT", percentage: "0.1" },
              }),
              component({ itemId: VESSEL }),
            ],
          },
        ),
      );
      expect(result.adjustedUnits).toBe(9);
      expect(result.theoreticalUnits).toBe(10);
    });

    it("applies fixed loss once per configured batch", () => {
      // 158 oz with 1 oz lost per batch of 10 still yields exactly 10.
      const result = calculateCapacity(
        currentCandle(
          { [WAX]: oz("158"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          {
            components: [
              component({
                itemId: WAX,
                perUnitBase: oz("15.7"),
                countable: false,
                loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: oz("1"), batchSize: 10 },
              }),
              component({ itemId: VESSEL }),
            ],
          },
        ),
      );
      expect(result.adjustedUnits).toBe(10);
    });

    it("charges a second batch loss once the batch size is exceeded", () => {
      // 11 candles needs two batches, so two fixed losses.
      const result = calculateCapacity(
        currentCandle(
          { [WAX]: oz("174.7"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          {
            components: [
              component({
                itemId: WAX,
                perUnitBase: oz("15.7"),
                countable: false,
                loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: oz("1"), batchSize: 10 },
              }),
              component({ itemId: VESSEL }),
            ],
          },
        ),
      );
      // 11 units would need 11*15.7 + 2*1 = 174.7 exactly.
      expect(result.adjustedUnits).toBe(11);
    });

    it("combines percentage and fixed loss under BOTH", () => {
      const result = calculateCapacity(
        currentCandle(
          { [WAX]: oz("200"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          {
            components: [
              component({
                itemId: WAX,
                perUnitBase: oz("15.7"),
                countable: false,
                loss: {
                  mode: "BOTH",
                  percentage: "0.05",
                  fixedPerBatchBase: oz("2"),
                  batchSize: 5,
                },
              }),
              component({ itemId: VESSEL }),
            ],
          },
        ),
      );
      // Never more than the no-loss answer, and loss must cost something.
      expect(result.adjustedUnits).toBeLessThan(12);
      expect(result.adjustedUnits).toBeGreaterThan(0);
    });

    it("ignores loss entirely when the owner has not enabled it", () => {
      const result = calculateCapacity(
        currentCandle(
          { [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" },
          {
            lossEnabled: false,
            components: [
              component({
                itemId: WAX,
                perUnitBase: oz("15.7"),
                countable: false,
                loss: { mode: "PERCENT_PER_UNIT", percentage: "0.5" },
              }),
              component({ itemId: VESSEL }),
            ],
          },
        ),
      );
      expect(result.adjustedUnits).toBe(10);
    });
  });

  describe("shortfall reporting", () => {
    it("reports what one more unit would need", () => {
      const result = calculateCapacity(
        currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" }),
      );
      const waxShortfall = result.shortfallForOneMore.find((s) => s.itemId === WAX);
      expect(waxShortfall).toBeDefined();
      // Making an 11th candle needs another 15.7 oz of wax.
      expect(waxShortfall!.shortfall).toBe(oz("15.7"));
    });

    it("reports no shortfall for components that already have headroom", () => {
      const result = calculateCapacity(
        currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" }),
      );
      expect(result.shortfallForOneMore.some((s) => s.itemId === VESSEL)).toBe(false);
    });
  });

  it("treats an unknown item as zero available rather than throwing", () => {
    const result = calculateCapacity(currentCandle({ [WAX]: oz("157") }));
    expect(result.adjustedUnits).toBe(0);
  });

  it("labels the result hypothetical, since shared materials are not reserved", () => {
    const result = calculateCapacity(
      currentCandle({ [WAX]: oz("157"), [FRAGRANCE]: oz("26"), [VESSEL]: "20", [WICK]: "20" }),
    );
    expect(result.hypothetical).toBe(true);
  });

  it("rejects a recipe with no production-critical components", () => {
    expect(() =>
      calculateCapacity(
        currentCandle({}, { components: [component({ itemId: BOX, dependencyClass: "ADVISORY" })] }),
      ),
    ).toThrow("no production-critical components");
  });
});
