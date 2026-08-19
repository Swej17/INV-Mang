import { describe, expect, it } from "vitest";

import { parseInstant } from "./parse-instant.js";

describe("parseInstant", () => {
  it("returns the epoch millisecond value of a valid instant", () => {
    expect(parseInstant("2026-08-16T12:00:00.000Z", "assessedAt")).toBe(
      Date.parse("2026-08-16T12:00:00.000Z"),
    );
  });

  it("refuses a value Date.parse cannot make sense of, naming the label and the value", () => {
    expect(() => parseInstant("not-a-date", "assessedAt")).toThrow(
      "assessedAt is not a valid instant: not-a-date",
    );
  });

  it("refuses an empty string", () => {
    expect(() => parseInstant("", "occursAt")).toThrow(/instant/);
  });
});
