import { describe, expect, it } from "vitest";

import { convertQuantity } from "../units/convert.js";
import { calculateCapacity, type CapacityInput } from "./calculate-capacity.js";
import { allocateProduction, type ProductionDemand } from "../allocation/allocate-production.js";

/**
 * Negative and degenerate magnitudes must be REFUSED, not computed with.
 *
 * A cold review found that every one of these was silently accepted, and each
 * inverted an invariant the design document calls critical:
 *
 *   negative protected stock -> protection increased capacity (10 -> 234)
 *   negative loss percentage -> loss increased capacity (10 -> 20)
 *   negative availability    -> the planner produced 449538 g of wax from 4450 g
 *
 * The property suites missed all of it because their generators only ever
 * produced non-negative samples. These are the boundary cases those generators
 * could not reach.
 */

const WAX = "0199a200-0000-7000-8000-000000000001";
const VESSEL = "0199a200-0000-7000-8000-000000000003";

function oz(count: string): string {
  return convertQuantity({ value: count, unit: "OUNCE" }, "GRAM").value;
}

function input(overrides: Partial<CapacityInput> = {}): CapacityInput {
  return {
    recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
    components: [
      {
        itemId: WAX,
        perUnitBase: oz("15.7"),
        dependencyClass: "PRODUCTION_CRITICAL",
        loss: { mode: "NONE" },
        countable: false,
      },
    ],
    availableByItem: { [WAX]: oz("157") },
    lossEnabled: true,
    ...overrides,
  };
}

describe("calculateCapacity refuses invalid magnitudes", () => {
  it("refuses negative protected stock", () => {
    // Would otherwise ADD to availability and raise capacity above theoretical.
    expect(() =>
      calculateCapacity(input({ protectedByItem: { [WAX]: `-${oz("78.5")}` } })),
    ).toThrow("must not be negative");
  });

  it("refuses negative availability", () => {
    expect(() => calculateCapacity(input({ availableByItem: { [WAX]: "-100" } }))).toThrow(
      "must not be negative",
    );
  });

  it("refuses a negative loss percentage", () => {
    expect(() =>
      calculateCapacity(
        input({
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "PERCENT_PER_UNIT", percentage: "-0.5" },
              countable: false,
            },
          ],
        }),
      ),
    ).toThrow("must not be negative");
  });

  it("refuses a negative fixed batch loss", () => {
    expect(() =>
      calculateCapacity(
        input({
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: `-${oz("1")}`, batchSize: 10 },
              countable: false,
            },
          ],
        }),
      ),
    ).toThrow("must not be negative");
  });

  it("refuses a negative per-unit requirement", () => {
    expect(() =>
      calculateCapacity(
        input({
          components: [
            {
              itemId: WAX,
              perUnitBase: `-${oz("15.7")}`,
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "NONE" },
              countable: false,
            },
          ],
        }),
      ),
    ).toThrow("must not be negative");
  });

  it("refuses a zero per-unit requirement, which makes the search unbounded", () => {
    // Previously reported 2199023255551 units — a search artefact, not an answer.
    expect(() =>
      calculateCapacity(
        input({
          components: [
            {
              itemId: WAX,
              perUnitBase: "0",
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "NONE" },
              countable: false,
            },
          ],
        }),
      ),
    ).toThrow("greater than zero");
  });

  it.each([[0], [-1], [0.5]])("refuses a batchSize of %s", (batchSize) => {
    expect(() =>
      calculateCapacity(
        input({
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: oz("1"), batchSize },
              countable: false,
            },
          ],
        }),
      ),
    ).toThrow("positive integer");
  });
});

describe("allocateProduction refuses invalid magnitudes", () => {
  function demand(overrides: Partial<ProductionDemand> = {}): ProductionDemand {
    return {
      finishedItemId: "0199a300-0000-7000-8000-000000000001",
      sku: "SKU-A",
      requestedUnits: 5,
      recipeVersionId: "0199a200-0000-7000-8000-0000000000a1",
      components: [
        {
          itemId: WAX,
          perUnitBase: oz("15.7"),
          dependencyClass: "PRODUCTION_CRITICAL",
          loss: { mode: "NONE" },
          countable: false,
        },
      ],
      paidOrderDueAt: null,
      orderShortfallUnits: 0,
      ownerPriority: 0,
      forecastStockoutAt: null,
      salesVelocity: "0",
      ...overrides,
    };
  }

  it("refuses negative availability instead of creating material", () => {
    // The review's worst case: 4450 g of supply yielded 449538 g of residual.
    expect(() =>
      allocateProduction({
        demands: [demand()],
        availableByItem: { [WAX]: `-${oz("100")}` },
        lossEnabled: true,
      }),
    ).toThrow("must not be negative");
  });

  it("refuses negative protected stock", () => {
    expect(() =>
      allocateProduction({
        demands: [demand()],
        availableByItem: { [WAX]: oz("157") },
        protectedByItem: { [WAX]: `-${oz("50")}` },
        lossEnabled: true,
      }),
    ).toThrow("must not be negative");
  });

  it("refuses a recipe with no production-critical components", () => {
    // Previously allocated 1000 units from an empty pool, status FULFILLED.
    expect(() =>
      allocateProduction({
        demands: [
          demand({
            requestedUnits: 1000,
            components: [
              {
                itemId: VESSEL,
                perUnitBase: "1",
                dependencyClass: "ADVISORY",
                loss: { mode: "NONE" },
                countable: true,
              },
            ],
          }),
        ],
        availableByItem: {},
        lossEnabled: true,
      }),
    ).toThrow("no production-critical components");
  });

  it.each([[-1], [2.5]])("refuses a requestedUnits of %s", (units) => {
    expect(() =>
      allocateProduction({
        demands: [demand({ requestedUnits: units })],
        availableByItem: { [WAX]: oz("157") },
        lossEnabled: true,
      }),
    ).toThrow("non-negative integer");
  });

  it("excludes ADVISORY components from constraining production", () => {
    // Capacity proves this; allocation did not, and the mutation survived.
    const result = allocateProduction({
      demands: [
        demand({
          requestedUnits: 5,
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "NONE" },
              countable: false,
            },
            {
              itemId: VESSEL,
              perUnitBase: "1",
              dependencyClass: "ADVISORY",
              loss: { mode: "NONE" },
              countable: true,
            },
          ],
        }),
      ],
      availableByItem: { [WAX]: oz("157"), [VESSEL]: "0" },
      lossEnabled: true,
    });
    expect(result.lines[0]!.allocatedUnits).toBe(5);
  });

  it("honours protected stock when allocating", () => {
    // protectedByItem appeared in zero allocation tests before this.
    const result = allocateProduction({
      demands: [demand({ requestedUnits: 10 })],
      availableByItem: { [WAX]: oz("157") },
      protectedByItem: { [WAX]: oz("78.5") },
      lossEnabled: true,
    });
    expect(result.lines[0]!.allocatedUnits).toBe(5);
  });

  it("applies loss when drawing down the pool", () => {
    // Every prior allocation test used loss NONE, so lossEnabled was inert.
    const withLoss = allocateProduction({
      demands: [
        demand({
          requestedUnits: 10,
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: oz("10"), batchSize: 5 },
              countable: false,
            },
          ],
        }),
      ],
      availableByItem: { [WAX]: oz("157") },
      lossEnabled: true,
    });
    const withoutLoss = allocateProduction({
      demands: [
        demand({
          requestedUnits: 10,
          components: [
            {
              itemId: WAX,
              perUnitBase: oz("15.7"),
              dependencyClass: "PRODUCTION_CRITICAL",
              loss: { mode: "FIXED_PER_BATCH", fixedPerBatchBase: oz("10"), batchSize: 5 },
              countable: false,
            },
          ],
        }),
      ],
      availableByItem: { [WAX]: oz("157") },
      lossEnabled: false,
    });
    expect(withLoss.lines[0]!.allocatedUnits).toBeLessThan(withoutLoss.lines[0]!.allocatedUnits);
  });
});
