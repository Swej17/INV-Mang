import { Decimal, assertNonNegativeDecimal } from "../units/convert.js";
import { requiredForUnits, type RecipeComponent } from "../capacity/calculate-capacity.js";
import { comparePriority, type ProductionDemand } from "./priority.js";

/**
 * Allocates shared materials across several products at once.
 *
 * Per-product capacity (Task 5) is hypothetical: ask "how many lavender can I
 * make" and "how many cedar can I make" separately and both answers count the
 * same wax. This is where that is resolved. Demands are ranked, then satisfied
 * sequentially against a residual pool, so a unit of wax can be promised
 * exactly once.
 */

export type AllocationLineStatus = "FULFILLED" | "PARTIAL" | "BLOCKED";

export type AllocationBlocker = Readonly<{
  itemId: string;
  required: string;
  remaining: string;
  shortfall: string;
}>;

export type AllocationLine = Readonly<{
  finishedItemId: string;
  sku: string;
  requestedUnits: number;
  allocatedUnits: number;
  status: AllocationLineStatus;
  /** Why the unallocated remainder could not be planned. Empty when FULFILLED. */
  blockers: readonly AllocationBlocker[];
}>;

export type AllocationRequest = Readonly<{
  demands: readonly ProductionDemand[];
  availableByItem: Readonly<Record<string, string>>;
  protectedByItem?: Readonly<Record<string, string>>;
  lossEnabled: boolean;
  /** A dry run computes the same plan but must not be committed. */
  dryRun?: boolean;
}>;

export type AllocationResult = Readonly<{
  lines: readonly AllocationLine[];
  /** Material left after the whole plan. Never negative. */
  residualByItem: Readonly<Record<string, string>>;
  /** Material this plan would consume, ready to post as reservations. */
  consumptionByItem: Readonly<Record<string, string>>;
  /** False for a dry run, so a caller cannot mistake a preview for a plan. */
  reservable: boolean;
}>;

type Pool = Map<string, InstanceType<typeof Decimal>>;

function buildPool(request: AllocationRequest): Pool {
  const pool: Pool = new Map();
  for (const [itemId, value] of Object.entries(request.availableByItem)) {
    let available = assertNonNegativeDecimal(value, `availableByItem[${itemId}]`);
    const held = request.protectedByItem?.[itemId];
    if (held !== undefined) {
      available = available.minus(assertNonNegativeDecimal(held, `protectedByItem[${itemId}]`));
    }
    pool.set(itemId, available.isNegative() ? new Decimal(0) : available);
  }
  return pool;
}

function remaining(pool: Pool, itemId: string): InstanceType<typeof Decimal> {
  // Absent means none, never unlimited.
  return pool.get(itemId) ?? new Decimal(0);
}

/**
 * Largest whole units of this demand the residual pool can still support.
 *
 * Searched rather than divided, for the same reason as Task 5: fixed batch loss
 * makes requirement a step function, so division overestimates at a boundary.
 */
function maxAllocatable(
  critical: readonly RecipeComponent[],
  pool: Pool,
  lossEnabled: boolean,
  ceiling: number,
): number {
  const fits = (units: number): boolean =>
    critical.every((component) =>
      requiredForUnits(component, BigInt(units), lossEnabled).lessThanOrEqualTo(
        remaining(pool, component.itemId),
      ),
    );

  if (ceiling <= 0 || !fits(1)) return 0;

  let low = 1;
  let high = ceiling;
  if (fits(high)) return high;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export function allocateProduction(request: AllocationRequest): AllocationResult {
  const pool = buildPool(request);
  const consumed: Pool = new Map();

  // Sort a copy: mutating the caller's array would make a dry run followed by a
  // live run behave differently.
  const ordered = [...request.demands].sort(comparePriority);

  const lines: AllocationLine[] = [];
  for (const demand of ordered) {
    // Only production-critical components constrain making things. Fulfillment
    // and advisory shortages are surfaced elsewhere and must never reduce the
    // number of candles planned.
    const critical = demand.components.filter(
      (component) => component.dependencyClass === "PRODUCTION_CRITICAL",
    );

    // Match calculateCapacity rather than silently granting the whole request:
    // a recipe whose components are all advisory would otherwise let the planner
    // promise unlimited production from an empty pool.
    if (critical.length === 0) {
      throw new Error(
        `no production-critical components: capacity is undefined for recipe ${demand.recipeVersionId}`,
      );
    }
    if (!Number.isInteger(demand.requestedUnits) || demand.requestedUnits < 0) {
      throw new Error(
        `requestedUnits must be a non-negative integer, received ${demand.requestedUnits}`,
      );
    }
    const allocated = maxAllocatable(critical, pool, request.lossEnabled, demand.requestedUnits);

    // Draw down the pool before considering the next demand. This sequential
    // draw is what prevents the same material being promised twice.
    for (const component of critical) {
      if (allocated <= 0) continue;
      const used = requiredForUnits(component, BigInt(allocated), request.lossEnabled);
      pool.set(component.itemId, remaining(pool, component.itemId).minus(used));
      consumed.set(
        component.itemId,
        (consumed.get(component.itemId) ?? new Decimal(0)).plus(used),
      );
    }

    const blockers: AllocationBlocker[] = [];
    if (allocated < demand.requestedUnits) {
      const oneMore = BigInt(allocated + 1);
      for (const component of critical) {
        const required = requiredForUnits(component, oneMore, request.lossEnabled);
        const left = remaining(pool, component.itemId).plus(
          allocated > 0
            ? requiredForUnits(component, BigInt(allocated), request.lossEnabled)
            : new Decimal(0),
        );
        if (required.greaterThan(left)) {
          blockers.push({
            itemId: component.itemId,
            required: required.toFixed(),
            remaining: remaining(pool, component.itemId).toFixed(),
            shortfall: required.minus(left).toFixed(),
          });
        }
      }
    }

    lines.push({
      finishedItemId: demand.finishedItemId,
      sku: demand.sku,
      requestedUnits: demand.requestedUnits,
      allocatedUnits: allocated,
      status:
        allocated === demand.requestedUnits
          ? "FULFILLED"
          : allocated === 0
            ? "BLOCKED"
            : "PARTIAL",
      blockers,
    });
  }

  const residualByItem: Record<string, string> = {};
  for (const [itemId, value] of pool) {
    residualByItem[itemId] = (value.isNegative() ? new Decimal(0) : value).toFixed();
  }
  const consumptionByItem: Record<string, string> = {};
  for (const [itemId, value] of consumed) {
    consumptionByItem[itemId] = value.toFixed();
  }

  return {
    lines,
    residualByItem,
    consumptionByItem,
    reservable: request.dryRun !== true,
  };
}

export type { ProductionDemand };
export { comparePriority };
