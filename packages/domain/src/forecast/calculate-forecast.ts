import { Decimal, assertNonNegativeDecimal } from "../units/convert.js";
import { parseInstant } from "../time/parse-instant.js";

/**
 * How much of a finished good will be needed over a horizon.
 *
 * Deliberately an explainable weighted baseline, not a learned model. The design
 * document forbids opaque forecasts: every number here can be recomputed by hand
 * from the reported inputs, because an owner deciding whether to buy 40 kg of
 * wax needs to see why, not be told to trust it.
 */

export type DemandWindow = Readonly<{
  units: string;
  /** Days of real data behind this window. Guards against dividing by zero. */
  coveredDays: number;
}>;

export type ForecastHistory = Readonly<{
  finishedItemId: string;
  asOf: string;
  recent30: DemandWindow | null;
  recent90: DemandWindow | null;
  priorYearSamePeriod: DemandWindow | null;
  monthsOfUsableHistory: number;
  /** Month index (0-11) to index. Applied only with 12+ months of history. */
  seasonalIndexByMonth: Readonly<Record<number, string>>;
}>;

export type ManualDemandEvent = Readonly<{
  eventId: string;
  units: number;
  reason: string;
  occursAt: string;
}>;

export type ForecastOverride = Readonly<{
  units: string;
  reason: string;
  expiresAt: string;
}>;

export type ForecastResult = Readonly<{
  finishedItemId: string;
  horizonDays: number;
  weights: Readonly<{ recent30: string; recent90: string; priorYear: string }>;
  dailyVelocity: string;
  /** Seasonally adjusted statistical demand, excluding manual events. */
  statisticalDemandUnits: string;
  manualDemandUnits: string;
  manualEvents: readonly ManualDemandEvent[];
  /** Statistical + manual, before any override. Always preserved. */
  computedDemandUnits: string;
  /** What the caller should act on: the override when live, else computed. */
  totalDemandUnits: string;
  override: ForecastOverride | null;
  seasonalFactor: string;
  hasUsableHistory: boolean;
  inputs: Readonly<Record<string, string | number>>;
}>;

const BASE_WEIGHTS = { recent30: "0.5", recent90: "0.3", priorYear: "0.2" } as const;
const SEASONAL_FLOOR = "0.5";
const SEASONAL_CEILING = "2.0";
const MONTHS_BEFORE_SEASONALITY = 12;

function velocity(window: DemandWindow | null, label: string): InstanceType<typeof Decimal> | null {
  if (window === null) return null;
  const units = assertNonNegativeDecimal(window.units, `${label}.units`);
  if (!Number.isInteger(window.coveredDays) || window.coveredDays <= 0) {
    throw new Error(`${label}.coveredDays must be a positive integer`);
  }
  return units.dividedBy(window.coveredDays);
}

export function calculateForecast(
  history: ForecastHistory,
  horizonDays: number,
  manualEvents: readonly ManualDemandEvent[] = [],
  override: ForecastOverride | null = null,
): ForecastResult {
  if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
    throw new Error(`horizon must be a positive whole number of days, received ${horizonDays}`);
  }

  const v30 = velocity(history.recent30, "recent30");
  const v90 = velocity(history.recent90, "recent90");
  const vPrior = velocity(history.priorYearSamePeriod, "priorYearSamePeriod");

  // Missing windows redistribute their weight PROPORTIONALLY across what
  // remains, rather than defaulting to zero. Dropping a window's weight
  // entirely would understate demand precisely when history is thinnest.
  const present: { key: keyof typeof BASE_WEIGHTS; value: InstanceType<typeof Decimal> }[] = [];
  if (v30) present.push({ key: "recent30", value: v30 });
  if (v90) present.push({ key: "recent90", value: v90 });
  if (vPrior) present.push({ key: "priorYear", value: vPrior });

  const totalBaseWeight = present.reduce(
    (total, entry) => total.plus(new Decimal(BASE_WEIGHTS[entry.key])),
    new Decimal(0),
  );

  const weights = { recent30: "0", recent90: "0", priorYear: "0" } as Record<string, string>;
  let dailyVelocity = new Decimal(0);
  for (const entry of present) {
    const share = new Decimal(BASE_WEIGHTS[entry.key]).dividedBy(totalBaseWeight);
    weights[entry.key] = share.toFixed();
    dailyVelocity = dailyVelocity.plus(share.times(entry.value));
  }

  // Parsed once and reused below: every date derived from this forecast is
  // relative to asOf, so one bad value must not let some derived comparisons
  // fail loud and others fail silent depending on which Date.parse call sees it.
  const asOfMs = parseInstant(history.asOf, "history.asOf");

  // Seasonality only once there is a full year to derive it from, and clamped,
  // because a sparse history produces indices that swing wildly and would turn
  // one good month into a standing order.
  const month = new Date(asOfMs).getUTCMonth();
  const rawIndex = history.seasonalIndexByMonth[month];
  let seasonalFactor = new Decimal(1);
  if (history.monthsOfUsableHistory >= MONTHS_BEFORE_SEASONALITY && rawIndex !== undefined) {
    const index = assertNonNegativeDecimal(rawIndex, "seasonalIndex");
    seasonalFactor = Decimal.max(
      new Decimal(SEASONAL_FLOOR),
      Decimal.min(new Decimal(SEASONAL_CEILING), index),
    );
  }

  const statistical = dailyVelocity.times(horizonDays).times(seasonalFactor);

  // Manual events are commitments, not estimates: they are NOT scaled by the
  // seasonal factor, and they are reported separately so an owner can see which
  // part of the number is a booking and which part is a guess.
  const horizonEnd = asOfMs + horizonDays * 86_400_000;
  const counted = manualEvents.filter((event) => {
    if (event.units < 0) throw new Error(`manual event units must not be negative: ${event.units}`);
    const at = parseInstant(event.occursAt, `manual event ${event.eventId} occursAt`);
    return at >= asOfMs && at <= horizonEnd;
  });
  const manualDemand = counted.reduce(
    (total, event) => total.plus(new Decimal(event.units)),
    new Decimal(0),
  );

  const computed = statistical.plus(manualDemand);

  let liveOverride: ForecastOverride | null = null;
  if (override !== null) {
    if (override.reason.trim() === "") {
      throw new Error("a forecast override requires a written reason");
    }
    assertNonNegativeDecimal(override.units, "override.units");
    if (parseInstant(override.expiresAt, "override.expiresAt") > asOfMs) liveOverride = override;
  }

  return {
    finishedItemId: history.finishedItemId,
    horizonDays,
    weights: {
      recent30: weights["recent30"]!,
      recent90: weights["recent90"]!,
      priorYear: weights["priorYear"]!,
    },
    dailyVelocity: dailyVelocity.toFixed(),
    statisticalDemandUnits: statistical.toFixed(),
    manualDemandUnits: manualDemand.toFixed(),
    manualEvents: counted,
    // Both survive an override, so when one expires the real number reappears
    // rather than having been overwritten.
    computedDemandUnits: computed.toFixed(),
    totalDemandUnits: liveOverride
      ? new Decimal(liveOverride.units).toFixed()
      : computed.toFixed(),
    override: liveOverride,
    seasonalFactor: seasonalFactor.toFixed(),
    hasUsableHistory: present.length > 0,
    inputs: {
      recent30Units: history.recent30?.units ?? "0",
      recent30Days: history.recent30?.coveredDays ?? 0,
      recent90Units: history.recent90?.units ?? "0",
      recent90Days: history.recent90?.coveredDays ?? 0,
      priorYearUnits: history.priorYearSamePeriod?.units ?? "0",
      monthsOfUsableHistory: history.monthsOfUsableHistory,
      horizonDays,
      seasonalFactor: seasonalFactor.toFixed(),
    },
  };
}
