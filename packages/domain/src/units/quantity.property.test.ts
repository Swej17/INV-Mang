import { describe, expect, it } from "vitest";

import { convertQuantity } from "./convert.js";
import { addQuantity, compareQuantity } from "./quantity.js";

/**
 * Deterministic pseudo-random sampling. A fixed seed keeps failures
 * reproducible; unseeded Math.random would make a red build unrepeatable.
 */
function* samples(count: number, seed = 20260815): Generator<string> {
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const whole = state % 100000;
    const fraction = (state >> 7) % 10000;
    yield `${whole}.${String(fraction).padStart(4, "0")}`;
  }
}

describe("mass conversion properties", () => {
  it("round-trips ounce to gram and back within 0.0000001 gram", () => {
    for (const value of samples(200)) {
      const grams = convertQuantity({ value, unit: "OUNCE" }, "GRAM");
      const back = convertQuantity(grams, "OUNCE");
      const drift = Math.abs(Number(back.value) - Number(value));
      expect(drift).toBeLessThan(0.0000001);
    }
  });

  it("never returns a negative magnitude for a positive input", () => {
    for (const value of samples(100, 7)) {
      expect(Number(convertQuantity({ value, unit: "POUND" }, "GRAM").value)).toBeGreaterThanOrEqual(
        0,
      );
    }
  });

  it("is monotonic: a larger input never converts to a smaller output", () => {
    let previous = -Infinity;
    for (const value of [...samples(50, 99)].sort((a, b) => Number(a) - Number(b))) {
      const grams = Number(convertQuantity({ value, unit: "OUNCE" }, "GRAM").value);
      expect(grams).toBeGreaterThanOrEqual(previous);
      previous = grams;
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
    const left = addQuantity(addQuantity(a, b, "GRAM"), c, "GRAM");
    const right = addQuantity(a, addQuantity(b, c, "GRAM"), "GRAM");
    expect(left).toEqual(right);
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
    expect(compareQuantity({ value: "1", unit: "POUND" }, { value: "453.59237", unit: "GRAM" })).toBe(
      0,
    );
  });

  it("is antisymmetric", () => {
    const a = { value: "2", unit: "POUND" } as const;
    const b = { value: "1", unit: "POUND" } as const;
    expect(compareQuantity(a, b)).toBe(1);
    expect(compareQuantity(b, a)).toBe(-1);
  });

  it("does not use display rounding to decide equality", () => {
    // These differ far below any display precision and must not compare equal.
    expect(
      compareQuantity({ value: "1.00000001", unit: "GRAM" }, { value: "1", unit: "GRAM" }),
    ).toBe(1);
  });
});
