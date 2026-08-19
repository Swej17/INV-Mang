import { describe, expect, it } from "vitest";

import { recommendPurchase, type ReorderPolicy, type VendorOffer } from "./recommend.js";

const WAX = "0199a200-0000-7000-8000-000000000001";
const ACME = "0199a700-0000-7000-8000-000000000001";
const BULK = "0199a700-0000-7000-8000-000000000002";

function vendor(overrides: Partial<VendorOffer> = {}): VendorOffer {
  return {
    vendorId: ACME,
    vendorName: "Acme Wax Co.",
    preferred: true,
    productUrl: "https://example.test/wax",
    vendorSku: "WAX-464-10LB",
    /** One purchase unit yields this much base unit. */
    packConversion: "1",
    packSize: "1",
    minimumOrderQuantity: "1",
    reorderMultiple: "1",
    unitPrice: "42.50",
    leadTimeDays: 7,
    shippingEstimate: "12.00",
    ...overrides,
  };
}

function policy(overrides: Partial<ReorderPolicy> = {}): ReorderPolicy {
  return {
    itemId: WAX,
    /** Base units consumed per day. */
    dailyDemand: "10",
    available: "0",
    usableIncoming: "0",
    protectedQuantity: "0",
    safetyDays: 3,
    targetCoverageDays: 30,
    asOf: "2026-08-16T00:00:00.000Z",
    offers: [vendor()],
    ...overrides,
  };
}

describe("recommendPurchase", () => {
  it("rounds up to pack size and minimum order", () => {
    const result = recommendPurchase(
      policy({
        dailyDemand: "1",
        targetCoverageDays: 13,
        offers: [vendor({ packSize: "12", minimumOrderQuantity: "24", reorderMultiple: "12" })],
      }),
    );
    expect(result.recommendedPurchaseUnits).toBe("24");
  });

  it("never recommends a negative quantity", () => {
    // Plenty on hand: the answer is "buy nothing", not a negative order.
    const result = recommendPurchase(policy({ available: "10000" }));
    expect(result.recommendedPurchaseUnits).toBe("0");
    expect(result.shouldReorder).toBe(false);
  });

  it("computes the reorder point as leadTime + safety + protected demand", () => {
    // 10/day, 7 day lead, 3 safety days, 50 protected => 100 + 50 = 150.
    const result = recommendPurchase(policy({ protectedQuantity: "50" }));
    expect(result.reorderPoint).toBe("150");
  });

  it("counts protected stock toward the reorder point, not toward availability", () => {
    const withProtection = recommendPurchase(policy({ available: "200", protectedQuantity: "100" }));
    const without = recommendPurchase(policy({ available: "200", protectedQuantity: "0" }));
    // Protection raises the trigger threshold and is unavailable to consume.
    expect(Number(withProtection.reorderPoint)).toBeGreaterThan(Number(without.reorderPoint));
  });

  it("subtracts usable incoming from the recommendation", () => {
    const base = recommendPurchase(policy());
    const withIncoming = recommendPurchase(policy({ usableIncoming: "100" }));
    expect(Number(withIncoming.recommendedPurchaseUnits)).toBeLessThan(
      Number(base.recommendedPurchaseUnits),
    );
  });

  it("reports the expected stockout date from current cover", () => {
    // 300 available at 10/day = 30 days of cover.
    const result = recommendPurchase(policy({ available: "300" }));
    expect(result.expectedStockoutAt).toBe("2026-09-15T00:00:00.000Z");
  });

  it("reports an order-by date that leaves the lead time intact", () => {
    // Stockout at day 30, lead time 7 => order by day 23.
    const result = recommendPurchase(policy({ available: "300" }));
    expect(result.orderByAt).toBe("2026-09-08T00:00:00.000Z");
  });

  it("flags an order-by date already in the past as overdue", () => {
    const result = recommendPurchase(policy({ available: "0" }));
    expect(result.overdue).toBe(true);
  });

  it("prefers the preferred vendor and lists the rest as alternates", () => {
    // The alternate is deliberately CHEAPER and sorts first by id, so only the
    // preferred flag can explain the choice. With equal prices this test passed
    // even when preference was ignored entirely.
    const result = recommendPurchase(
      policy({
        offers: [
          vendor({ vendorId: BULK, vendorName: "Bulk Supply", preferred: false, unitPrice: "1.00" }),
          vendor({ vendorId: ACME, preferred: true, unitPrice: "99.00" }),
        ],
      }),
    );
    expect(result.vendorId).toBe(ACME);
    expect(result.alternateVendorIds).toEqual([BULK]);
  });

  it("falls back to the cheapest vendor when none is preferred", () => {
    const result = recommendPurchase(
      policy({
        offers: [
          vendor({ vendorId: ACME, preferred: false, unitPrice: "50.00" }),
          vendor({ vendorId: BULK, preferred: false, unitPrice: "31.25" }),
        ],
      }),
    );
    expect(result.vendorId).toBe(BULK);
  });

  it("estimates cost from unit price and shipping", () => {
    const result = recommendPurchase(
      policy({
        dailyDemand: "1",
        targetCoverageDays: 10,
        offers: [vendor({ unitPrice: "2.50", shippingEstimate: "7.00" })],
      }),
    );
    // 10 units at 2.50 = 25.00, plus 7.00 shipping.
    expect(result.estimatedCost).toBe("32");
  });

  it("shows every input so the recommendation can be audited", () => {
    const result = recommendPurchase(policy());
    expect(result.inputs).toMatchObject({
      dailyDemand: "10",
      leadTimeDays: 7,
      safetyDays: 3,
      targetCoverageDays: 30,
    });
    expect(result.reason).toContain("below reorder point");
  });

  it("carries the vendor product link through", () => {
    const result = recommendPurchase(policy());
    expect(result.productUrl).toBe("https://example.test/wax");
  });

  it("converts purchase units through the pack conversion", () => {
    // One case yields 10 base units; needing 300 means 30 cases.
    const result = recommendPurchase(
      policy({ offers: [vendor({ packConversion: "10" })] }),
    );
    expect(result.recommendedPurchaseUnits).toBe("30");
  });

  it("refuses a negative daily demand", () => {
    expect(() => recommendPurchase(policy({ dailyDemand: "-5" }))).toThrow("must not be negative");
  });

  it("refuses a non-positive pack conversion", () => {
    expect(() =>
      recommendPurchase(policy({ offers: [vendor({ packConversion: "0" })] })),
    ).toThrow("greater than zero");
  });

  it("handles zero demand without dividing by zero", () => {
    const result = recommendPurchase(policy({ dailyDemand: "0", available: "5" }));
    expect(result.shouldReorder).toBe(false);
    expect(result.expectedStockoutAt).toBeNull();
  });

  it("requires at least one vendor offer", () => {
    expect(() => recommendPurchase(policy({ offers: [] }))).toThrow("no vendor offer");
  });
});
