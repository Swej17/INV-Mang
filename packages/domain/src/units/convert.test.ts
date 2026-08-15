import { describe, expect, it } from "vitest";

import { convertQuantity } from "./convert.js";

describe("convertQuantity", () => {
  it("converts a ten pound case to grams without display rounding", () => {
    expect(convertQuantity({ value: "10", unit: "POUND" }, "GRAM")).toEqual({
      value: "4535.9237",
      unit: "GRAM",
    });
  });

  it("does not convert volume to mass", () => {
    expect(() => convertQuantity({ value: "1", unit: "MILLILITER" }, "GRAM")).toThrow(
      "incompatible dimensions",
    );
  });

  it("does not convert countable eaches to mass", () => {
    expect(() => convertQuantity({ value: "1", unit: "EACH" }, "GRAM")).toThrow(
      "incompatible dimensions",
    );
  });

  it("converts the current recipe wax charge exactly", () => {
    // 15.7 oz x 28.349523125 g/oz = 445.087513... g. Never display-rounded.
    expect(convertQuantity({ value: "15.7", unit: "OUNCE" }, "GRAM")).toEqual({
      value: "445.0875130625",
      unit: "GRAM",
    });
  });

  it("converts the current recipe fragrance charge exactly", () => {
    expect(convertQuantity({ value: "1.3", unit: "OUNCE" }, "GRAM")).toEqual({
      value: "36.8543800625",
      unit: "GRAM",
    });
  });

  it("returns an identical quantity for an identity conversion", () => {
    expect(convertQuantity({ value: "4535.9237", unit: "GRAM" }, "GRAM")).toEqual({
      value: "4535.9237",
      unit: "GRAM",
    });
  });

  it("round-trips pound to gram and back without drift", () => {
    const grams = convertQuantity({ value: "10", unit: "POUND" }, "GRAM");
    expect(convertQuantity(grams, "POUND")).toEqual({ value: "10", unit: "POUND" });
  });

  it("normalises trailing zeroes rather than emitting them", () => {
    expect(convertQuantity({ value: "1.500", unit: "POUND" }, "POUND")).toEqual({
      value: "1.5",
      unit: "POUND",
    });
  });

  it("keeps precision that binary floating point would lose", () => {
    // 0.1 + 0.2 style drift must never appear in a ledger quantity.
    expect(convertQuantity({ value: "0.1", unit: "OUNCE" }, "GRAM")).toEqual({
      value: "2.8349523125",
      unit: "GRAM",
    });
  });

  it("rejects a non-numeric quantity value", () => {
    expect(() => convertQuantity({ value: "ten", unit: "POUND" }, "GRAM")).toThrow(
      "invalid quantity",
    );
  });

  it("preserves eaches under identity conversion", () => {
    expect(convertQuantity({ value: "12", unit: "EACH" }, "EACH")).toEqual({
      value: "12",
      unit: "EACH",
    });
  });

  it("rejects a fractional each", () => {
    expect(() => convertQuantity({ value: "1.5", unit: "EACH" }, "EACH")).toThrow(
      "countable quantity must be an integer",
    );
  });
});
