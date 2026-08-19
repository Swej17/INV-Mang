import { describe, expect, it } from "vitest";

import { calculateCapacity, requiredForUnits, type RecipeComponent } from "./calculate-capacity.js";

/**
 * `countable` means the item cannot be split: vessels, wicks, labels, boxes.
 *
 * The flag existed on RecipeComponent from Task 5 and was read nowhere — every
 * caller treated a vessel exactly like wax. Two consequences, and they bite in
 * different places, so both are pinned here:
 *
 *   - Required quantities round UP. `complete-batch` writes this number straight
 *     into the ledger, so an unrounded 10.05 permanently puts a fractional
 *     vessel count into on-hand stock.
 *   - Available quantities round DOWN. Half a vessel is not usable, and
 *     counting it lets the planner promise a candle it cannot assemble.
 *
 * Every test below has a non-countable twin with identical numbers, so a
 * mutation that drops the `countable` check and applies the rule to everything
 * is caught just as surely as one that removes the rule.
 */

const VESSEL = "0199a200-0000-7000-8000-000000000003";
const RECIPE = "0199a200-0000-7000-8000-0000000000a1";

function component(overrides: Partial<RecipeComponent> = {}): RecipeComponent {
  return {
    itemId: VESSEL,
    perUnitBase: "0.5",
    dependencyClass: "PRODUCTION_CRITICAL",
    loss: { mode: "NONE" },
    countable: true,
    ...overrides,
  };
}

function capacityOf(overrides: Partial<RecipeComponent>, available: string, lossEnabled = false) {
  return calculateCapacity({
    recipeVersionId: RECIPE,
    components: [component(overrides)],
    availableByItem: { [VESSEL]: available },
    lossEnabled,
  });
}

describe("available quantities round down", () => {
  it("cannot use the fractional remainder of a countable item", () => {
    // 10.7 label sheets at half a sheet per candle. The .7 is not a usable
    // seventh of a sheet, so 20 candles, not 21 — and the shortfall for the
    // 21st is a whole sheet to buy, not the 0.3 that arithmetic on the raw
    // figure produces. The unit count alone cannot see the difference: a
    // required quantity is already whole, so comparing it against 10.7 or
    // against 10 picks the same number of candles either way.
    const result = capacityOf({ countable: true }, "10.7");
    expect(result.adjustedUnits).toBe(20);
    const shortfall = result.shortfallForOneMore.find((entry) => entry.itemId === VESSEL)!;
    expect(shortfall.available).toBe("10");
    expect(shortfall.shortfall).toBe("1");
  });

  it("uses every gram of an item that is not countable", () => {
    // Identical numbers, only `countable` differs. 0.7 of a kilo of wax is
    // genuinely usable, so the same stock supports one more candle.
    expect(capacityOf({ countable: false }, "10.7").adjustedUnits).toBe(21);
  });

  it("rounds down after protection is subtracted, not before", () => {
    // 12 vessels with 1.4 held back leaves 10.6 -> 10 usable -> 20 candles.
    // Flooring first would leave 12 - 1 = 11 and promise 22.
    const result = calculateCapacity({
      recipeVersionId: RECIPE,
      components: [component()],
      availableByItem: { [VESSEL]: "12" },
      protectedByItem: { [VESSEL]: "1.4" },
      lossEnabled: false,
    });
    expect(result.adjustedUnits).toBe(20);
    // Flooring in the wrong order leaves 10.6 usable here rather than 10, which
    // the unit count hides and only the reported figure exposes.
    const shortfall = result.shortfallForOneMore.find((entry) => entry.itemId === VESSEL)!;
    expect(shortfall.available).toBe("10");
  });

  it("applies to the theoretical figure too", () => {
    // Countability is physical, not a policy the owner can switch off the way
    // protection and loss are.
    expect(capacityOf({ countable: true }, "10.7").theoreticalUnits).toBe(20);
  });
});

describe("required quantities round up", () => {
  it("asks for a whole countable item when loss makes the total fractional", () => {
    // 10 candles, one vessel each, 0.5% breakage = 10.05 vessels. You cannot
    // draw 10.05 vessels from a shelf; you open 11.
    const vessel = component({
      perUnitBase: "1",
      loss: { mode: "PERCENT_PER_UNIT", percentage: "0.005" },
      countable: true,
    });
    expect(requiredForUnits(vessel, 10n, true).toFixed()).toBe("11");
  });

  it("leaves a non-countable requirement exact", () => {
    // Same loss, same arithmetic — wax really is consumed to the gram.
    const wax = component({
      perUnitBase: "1",
      loss: { mode: "PERCENT_PER_UNIT", percentage: "0.005" },
      countable: false,
    });
    expect(requiredForUnits(wax, 10n, true).toFixed()).toBe("10.05");
  });

  it("reports a shortfall in whole items the owner can actually buy", () => {
    // 10 sheets, half a sheet per candle, so 20 candles. The 21st needs 10.5
    // sheets of stock, which means buying a whole 11th sheet — reporting a
    // shortfall of 0.5 sends the owner to buy something that is not sold.
    // Availability is integral here on purpose, so this pins the ceiling on
    // the requirement alone; the flooring of stock is pinned above.
    const result = capacityOf({ countable: true }, "10");
    expect(result.adjustedUnits).toBe(20);
    const shortfall = result.shortfallForOneMore.find((entry) => entry.itemId === VESSEL)!;
    expect(shortfall.required).toBe("11");
    expect(shortfall.available).toBe("10");
    expect(shortfall.shortfall).toBe("1");
  });

  it("does not round a requirement that is already whole", () => {
    // Rounding up unconditionally would turn an exact 10 into 11 and quietly
    // over-consume on every batch.
    expect(requiredForUnits(component({ perUnitBase: "1" }), 10n, false).toFixed()).toBe("10");
  });
});
