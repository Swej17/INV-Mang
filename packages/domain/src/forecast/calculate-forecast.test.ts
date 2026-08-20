import { describe, expect, it } from "vitest";

import {
  calculateForecast,
  type ForecastHistory,
  type ManualDemandEvent,
} from "./calculate-forecast.js";

const CANDLE = "0199a200-0000-7000-8000-0000000000b1";

function historyFixture(overrides: Partial<ForecastHistory> = {}): ForecastHistory {
  return {
    finishedItemId: CANDLE,
    asOf: "2026-08-16T00:00:00.000Z",
    /** Units sold in the trailing 30 days, and how many days of data back it. */
    recent30: { units: "60", coveredDays: 30 },
    recent90: { units: "270", coveredDays: 90 },
    priorYearSamePeriod: null,
    monthsOfUsableHistory: 3,
    seasonalIndexByMonth: {},
    ...overrides,
  };
}

describe("calculateForecast", () => {
  it("redistributes prior-year weight when only 90 days exist", () => {
    // Base weights 0.5/0.3/0.2. With no prior year the 0.2 is shared in
    // proportion: 0.5/0.8 = 0.625 and 0.3/0.8 = 0.375.
    const result = calculateForecast(historyFixture(), 30);
    expect(result.weights).toEqual({ recent30: "0.625", recent90: "0.375", priorYear: "0" });
  });

  it("uses the full three-window weighting when a prior year exists", () => {
    const result = calculateForecast(
      historyFixture({
        priorYearSamePeriod: { units: "90", coveredDays: 30 },
        monthsOfUsableHistory: 18,
      }),
      30,
    );
    expect(result.weights).toEqual({ recent30: "0.5", recent90: "0.3", priorYear: "0.2" });
  });

  it("falls back to the only available window", () => {
    const result = calculateForecast(
      historyFixture({ recent90: null, priorYearSamePeriod: null }),
      30,
    );
    expect(result.weights).toEqual({ recent30: "1", recent90: "0", priorYear: "0" });
  });

  it("projects demand from the weighted daily velocity", () => {
    // 30-day velocity 2/day, 90-day velocity 3/day.
    // 0.625*2 + 0.375*3 = 2.375/day. Over 30 days = 71.25.
    const result = calculateForecast(historyFixture(), 30);
    expect(result.dailyVelocity).toBe("2.375");
    expect(result.statisticalDemandUnits).toBe("71.25");
  });

  it("scales with the horizon", () => {
    const thirty = calculateForecast(historyFixture(), 30);
    const ninety = calculateForecast(historyFixture(), 90);
    expect(Number(ninety.statisticalDemandUnits)).toBeCloseTo(
      Number(thirty.statisticalDemandUnits) * 3,
      6,
    );
  });

  it("returns zero demand with no history rather than throwing", () => {
    const result = calculateForecast(
      historyFixture({ recent30: null, recent90: null, priorYearSamePeriod: null }),
      30,
    );
    expect(result.statisticalDemandUnits).toBe("0");
    expect(result.hasUsableHistory).toBe(false);
  });

  describe("manual demand", () => {
    const market: ManualDemandEvent = {
      eventId: "0199a800-0000-7000-8000-000000000001",
      units: 40,
      reason: "October market",
      occursAt: "2026-09-01T00:00:00.000Z",
    };

    it("shows manual market demand separately", () => {
      const result = calculateForecast(historyFixture(), 30, [market]);
      expect(result.manualDemandUnits).toBe("40");
      // Statistical demand must stay untouched so the owner can see which is which.
      expect(result.statisticalDemandUnits).toBe("71.25");
      expect(result.totalDemandUnits).toBe("111.25");
    });

    it("ignores a manual event beyond the horizon", () => {
      const distant: ManualDemandEvent = { ...market, occursAt: "2027-01-01T00:00:00.000Z" };
      expect(calculateForecast(historyFixture(), 30, [distant]).manualDemandUnits).toBe("0");
    });

    it("lists the manual events it counted", () => {
      const result = calculateForecast(historyFixture(), 30, [market]);
      expect(result.manualEvents.map((e) => e.eventId)).toEqual([market.eventId]);
    });

    it("refuses a negative manual event", () => {
      expect(() =>
        calculateForecast(historyFixture(), 30, [{ ...market, units: -10 }]),
      ).toThrow("must not be negative");
    });

    it("a manual event with an unparseable date is an error, never silently dropped", () => {
      // An unparseable occursAt used to fail the range comparison silently and
      // drop the event, understating demand for exactly the record that most
      // needed a human to look at it.
      expect(() =>
        calculateForecast(historyFixture(), 30, [{ ...market, occursAt: "garbage" }]),
      ).toThrow(/instant/);
    });
  });

  describe("seasonality", () => {
    it("is not applied before twelve months of usable history", () => {
      const result = calculateForecast(
        historyFixture({ monthsOfUsableHistory: 11, seasonalIndexByMonth: { 7: "1.8" } }),
        30,
      );
      // Sparse history must not produce extreme recommendations.
      expect(result.seasonalFactor).toBe("1");
    });

    it("is applied after twelve months", () => {
      const result = calculateForecast(
        historyFixture({ monthsOfUsableHistory: 12, seasonalIndexByMonth: { 7: "1.5" } }),
        30,
      );
      expect(result.seasonalFactor).toBe("1.5");
    });

    it("clamps an extreme index to the 0.5-2.0 band", () => {
      const high = calculateForecast(
        historyFixture({ monthsOfUsableHistory: 24, seasonalIndexByMonth: { 7: "9" } }),
        30,
      );
      const low = calculateForecast(
        historyFixture({ monthsOfUsableHistory: 24, seasonalIndexByMonth: { 7: "0.01" } }),
        30,
      );
      expect(high.seasonalFactor).toBe("2");
      expect(low.seasonalFactor).toBe("0.5");
    });

    it("multiplies statistical demand but not manual demand", () => {
      // A booked market is a known commitment, not a seasonal estimate.
      const result = calculateForecast(
        historyFixture({ monthsOfUsableHistory: 12, seasonalIndexByMonth: { 7: "2" } }),
        30,
        [
          {
            eventId: "0199a800-0000-7000-8000-000000000002",
            units: 40,
            reason: "market",
            occursAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      );
      expect(result.statisticalDemandUnits).toBe("142.5");
      expect(result.manualDemandUnits).toBe("40");
      // The TOTAL is what proves the factor was not applied to the booking:
      // 142.5 + 40, not 142.5 + 80. Asserting only the reported manual field
      // left this passing even when the seasonal factor scaled it.
      expect(result.computedDemandUnits).toBe("182.5");
      expect(result.totalDemandUnits).toBe("182.5");
    });
  });

  describe("override", () => {
    it("preserves both the computed and the overridden value", () => {
      const result = calculateForecast(historyFixture(), 30, [], {
        units: "200",
        reason: "wholesale commitment not yet in orders",
        expiresAt: "2026-12-01T00:00:00.000Z",
      });
      expect(result.totalDemandUnits).toBe("200");
      // The computed number survives, so an expiring override reveals the real one.
      expect(result.computedDemandUnits).toBe("71.25");
      expect(result.override?.reason).toContain("wholesale");
    });

    it("ignores an expired override", () => {
      const result = calculateForecast(historyFixture(), 30, [], {
        units: "200",
        reason: "stale",
        expiresAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.totalDemandUnits).toBe("71.25");
      expect(result.override).toBeNull();
    });

    it("refuses an override without a reason", () => {
      expect(() =>
        calculateForecast(historyFixture(), 30, [], {
          units: "200",
          reason: "",
          expiresAt: "2026-12-01T00:00:00.000Z",
        }),
      ).toThrow("reason");
    });

    it("an override with an unparseable expiry is an error, never silently expired", () => {
      // An unparseable expiresAt used to fail the ">" comparison silently and
      // deactivate the override, discarding a deliberate owner decision.
      expect(() =>
        calculateForecast(historyFixture(), 30, [], {
          units: "200",
          reason: "wholesale commitment not yet in orders",
          expiresAt: "garbage",
        }),
      ).toThrow(/instant/);
    });
  });

  it("reports every input so the forecast can be audited", () => {
    const result = calculateForecast(historyFixture(), 30);
    expect(result.inputs).toMatchObject({
      recent30Units: "60",
      recent30Days: 30,
      recent90Units: "270",
      recent90Days: 90,
      horizonDays: 30,
    });
  });

  it("refuses a non-positive horizon", () => {
    expect(() => calculateForecast(historyFixture(), 0)).toThrow("horizon");
  });

  it("refuses negative sales history", () => {
    expect(() =>
      calculateForecast(historyFixture({ recent30: { units: "-5", coveredDays: 30 } }), 30),
    ).toThrow("must not be negative");
  });

  it("refuses a window covering zero days", () => {
    // Would divide by zero when deriving a daily velocity.
    expect(() =>
      calculateForecast(historyFixture({ recent30: { units: "10", coveredDays: 0 } }), 30),
    ).toThrow("coveredDays");
  });

  it("refuses an unparseable history.asOf rather than misreading every date derived from it", () => {
    expect(() => calculateForecast(historyFixture({ asOf: "garbage" }), 30)).toThrow(/instant/);
  });
});
