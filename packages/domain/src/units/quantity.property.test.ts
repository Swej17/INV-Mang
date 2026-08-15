import { Decimal as BaseDecimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { convertQuantity } from "./convert.js";
import { addQuantity, compareQuantity } from "./quantity.js";

/**
 * Assertions run in Decimal, never in JavaScript Number. The invariant under
 * test IS "inventory math never touches binary floating point", so a test that
 * reached for Number to check it would be able to pass while the invariant was
 * broken.
 */
const Decimal = BaseDecimal.clone({ precision: 60, toExpNeg: -60, toExpPos: 60 });

/** Tolerance is denominated in GRAMS, as the plan specifies. */
const MAX_DRIFT_GRAMS = new Decimal("0.0000001");

/** Deterministic sampling; a fixed seed keeps any red build reproducible. */
function* samples(count: number, seed = 20260815): Generator<string> {
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    yield `${state % 100000}.${String((state >> 7) % 10000).padStart(4, "0")}`;
  }
}

describe("mass conversion properties", () => {
  it("round-trips GRAM to OUNCE and back within 0.0000001 GRAM", () => {
    // Measured gram-to-gram, so the tolerance means what its name says. The
    // earlier ounce-denominated form was ~28.35x looser than advertised.
    for (const value of samples(200)) {
      const asOunces = convertQuantity({ value, unit: "GRAM" }, "OUNCE");
      const backToGrams = convertQuantity(asOunces, "GRAM");
      const drift = new Decimal(backToGrams.value).minus(new Decimal(value)).abs();
      expect(drift.lessThanOrEqualTo(MAX_DRIFT_GRAMS)).toBe(true);
    }
  });

  it.each([
    ["smallest stored magnitude", "0.00000001"],
    ["unit", "1"],
    ["mid range", "99999.9999"],
    ["numeric(24,8) upper bound", "9999999999999999.99999999"],
  ])("round-trips the %s boundary within tolerance", (_label, value) => {
    const backToGrams = convertQuantity(convertQuantity({ value, unit: "GRAM" }, "OUNCE"), "GRAM");
    const drift = new Decimal(backToGrams.value).minus(new Decimal(value)).abs();
    expect(drift.lessThanOrEqualTo(MAX_DRIFT_GRAMS)).toBe(true);
  });

  it("never returns a negative magnitude for a positive input", () => {
    for (const value of samples(100, 7)) {
      const grams = convertQuantity({ value, unit: "POUND" }, "GRAM");
      expect(compareQuantity(grams, { value: "0", unit: "GRAM" })).toBeGreaterThanOrEqual(0);
    }
  });

  it("is monotonic: a larger input never converts to a smaller output", () => {
    const ascending = [...samples(50, 99)].sort((a, b) =>
      new Decimal(a).comparedTo(new Decimal(b)),
    );
    let previous: { value: string; unit: "GRAM" } | undefined;
    for (const value of ascending) {
      const grams = convertQuantity({ value, unit: "OUNCE" }, "GRAM") as {
        value: string;
        unit: "GRAM";
      };
      if (previous) expect(compareQuantity(grams, previous)).toBeGreaterThanOrEqual(0);
      previous = grams;
    }
  });
});

describe("count properties", () => {
  it("keeps every generated integral EACH integral", () => {
    for (let n = 0; n < 200; n += 1) {
      const converted = convertQuantity({ value: String(n), unit: "EACH" }, "EACH");
      expect(new Decimal(converted.value).isInteger()).toBe(true);
      expect(converted.value).toBe(String(n));
    }
  });

  it("rejects every generated fractional EACH", () => {
    for (const value of samples(50, 4242)) {
      // samples always carry a fractional part
      expect(() => convertQuantity({ value, unit: "EACH" }, "EACH")).toThrow(
        "countable quantity must be an integer",
      );
    }
  });
});

describe("addQuantity properties", () => {
  it("is commutative across unit boundaries", () => {
    const a = { value: "15.7", unit: "OUNCE" } as const;
    const b = { value: "1.3", unit: "POUND" } as const;
    expect(addQuantity(a, b, "GRAM")).toEqual(addQuantity(b, a, "GRAM"));
  });

  it("is associative", () => {
    const a = { value: "1.1", unit: "OUNCE" } as const;
    const b = { value: "2.2", unit: "OUNCE" } as const;
    const c = { value: "3.3", unit: "OUNCE" } as const;
    expect(addQuantity(addQuantity(a, b, "GRAM"), c, "GRAM")).toEqual(
      addQuantity(a, addQuantity(b, c, "GRAM"), "GRAM"),
    );
  });

  it("treats zero as an identity element", () => {
    const a = { value: "445.0875130625", unit: "GRAM" } as const;
    expect(addQuantity(a, { value: "0", unit: "GRAM" }, "GRAM")).toEqual(a);
  });

  it("keeps countable sums integral", () => {
    expect(addQuantity({ value: "7", unit: "EACH" }, { value: "5", unit: "EACH" }, "EACH")).toEqual({
      value: "12",
      unit: "EACH",
    });
  });

  it("refuses to add across incompatible dimensions", () => {
    expect(() =>
      addQuantity({ value: "1", unit: "EACH" }, { value: "1", unit: "GRAM" }, "GRAM"),
    ).toThrow("incompatible dimensions");
  });
});

describe("compareQuantity properties", () => {
  it("orders equal magnitudes as equal regardless of unit", () => {
    expect(
      compareQuantity({ value: "1", unit: "POUND" }, { value: "453.59237", unit: "GRAM" }),
    ).toBe(0);
  });

  it("is antisymmetric", () => {
    const a = { value: "2", unit: "POUND" } as const;
    const b = { value: "1", unit: "POUND" } as const;
    expect(compareQuantity(a, b)).toBe(1);
    expect(compareQuantity(b, a)).toBe(-1);
  });

  it("does not use display rounding to decide equality", () => {
    expect(compareQuantity({ value: "1.00000001", unit: "GRAM" }, { value: "1", unit: "GRAM" })).toBe(
      1,
    );
  });

  it("separates magnitudes that differ only at the stored precision floor", () => {
    expect(
      compareQuantity(
        { value: "9999999999999999.99999999", unit: "GRAM" },
        { value: "9999999999999999.99999998", unit: "GRAM" },
      ),
    ).toBe(1);
  });
});
