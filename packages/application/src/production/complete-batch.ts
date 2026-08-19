import {
  requiredForUnits,
  selectFifoLots,
  totalDrawn,
  type Lot,
  type LotDraw,
  type RecipeComponent,
} from "@simple-flame/domain";
import type {
  InventoryLedgerRepository,
  LedgerEntryDraft,
} from "@simple-flame/persistence-contracts";

/**
 * Completes a production batch as ONE atomic operation.
 *
 * Either the whole batch happens — materials consumed from specific lots, loss
 * recorded, finished goods created, plan reservations released — or none of it
 * does. A partial batch is the worst outcome available: material would be gone
 * with no candles to show for it, and no single record would explain where it
 * went.
 */

export type Clock = { now: () => string };

export type RecipeVersionSnapshot = Readonly<{
  recipeVersionId: string;
  finishedItemId: string;
  active: boolean;
  components: readonly RecipeComponent[];
  /**
   * Items whose consumption must name its source lots.
   *
   * Without this the "no lots registered" case consumed material silently with
   * an empty lot list, destroying the recall record for exactly the materials
   * that need one — while one gram of registered lot was correctly refused.
   */
  lotControlledItemIds?: readonly string[];
}>;

export interface RecipeRepository {
  findVersion(recipeVersionId: string): Promise<RecipeVersionSnapshot | null>;
}

export interface LotRepository {
  listAvailable(itemId: string, locationId: string): Promise<readonly Lot[]>;
}

export type CompleteBatchInput = Readonly<{
  commandId: string;
  organizationId: string;
  batchId: string;
  recipeVersionId: string;
  locationId: string;
  finishedUnits: number;
  lossEnabled: boolean;
  /** Owner override of the FIFO proposal. Audited, and validated for total. */
  lotOverrides?: Readonly<Record<string, readonly LotDraw[]>>;
}>;

export type ProductionBatchResult = Readonly<{
  batchId: string;
  revision: string;
  finishedUnits: number;
  /** Which lots each component came from, for traceability. */
  lotsByItem: Readonly<Record<string, readonly LotDraw[]>>;
  /** Explicit loss postings, separate from consumption. */
  lossByItem: Readonly<Record<string, string>>;
}>;

export type CompleteProductionBatchDeps = Readonly<{
  recipes: RecipeRepository;
  lots: LotRepository;
  ledger: InventoryLedgerRepository;
  clock: Clock;
}>;

export class CompleteProductionBatch {
  constructor(private readonly deps: CompleteProductionBatchDeps) {}

  async execute(input: CompleteBatchInput): Promise<ProductionBatchResult> {
    if (!Number.isInteger(input.finishedUnits) || input.finishedUnits <= 0) {
      throw new Error(`finishedUnits must be a positive integer, received ${input.finishedUnits}`);
    }

    const recipe = await this.deps.recipes.findVersion(input.recipeVersionId);
    if (recipe === null) {
      throw new Error(`unknown recipe version ${input.recipeVersionId}`);
    }
    // A retired recipe must not be used for new production: its components no
    // longer reflect what the business makes, and the resulting batch would
    // misstate both cost and traceability.
    if (!recipe.active) {
      throw new Error(`recipe version ${input.recipeVersionId} is retired`);
    }

    const units = BigInt(input.finishedUnits);
    const critical = recipe.components.filter(
      (component) => component.dependencyClass === "PRODUCTION_CRITICAL",
    );
    if (critical.length === 0) {
      throw new Error("recipe has no production-critical components");
    }

    const entries: LedgerEntryDraft[] = [];
    const lotsByItem: Record<string, readonly LotDraw[]> = {};
    const lossByItem: Record<string, string> = {};
    const occurredAt = this.deps.clock.now();

    for (const component of critical) {
      // Total demand INCLUDING loss, and the loss portion separately, so the
      // ledger records what became product and what became waste rather than
      // blurring them into one consumption figure.
      const withLoss = requiredForUnits(component, units, input.lossEnabled);
      const withoutLoss = requiredForUnits(component, units, false);
      const loss = withLoss.minus(withoutLoss);

      const lotControlled = recipe.lotControlledItemIds?.includes(component.itemId) ?? false;
      const override = input.lotOverrides?.[component.itemId];
      let draws: readonly LotDraw[];
      if (override !== undefined) {
        // An override may choose different lots but not a different amount:
        // consuming less than the recipe requires would inflate yield.
        const drawn = totalDrawn(override);
        if (drawn !== withLoss.toFixed()) {
          throw new Error(
            `lot override for ${component.itemId} draws ${drawn}, recipe requires ${withLoss.toFixed()}`,
          );
        }
        // The total was validated but the lots were not: an override could name
        // a lot that does not exist and still be accepted, which is a
        // traceability record pointing at nothing.
        const known = new Set(
          (await this.deps.lots.listAvailable(component.itemId, input.locationId)).map(
            (lot) => lot.lotId,
          ),
        );
        const unknown = override.filter((draw) => !known.has(draw.lotId)).map((d) => d.lotId);
        if (unknown.length > 0) {
          throw new Error(
            `lot override for ${component.itemId} names unknown lot(s): ${unknown.join(", ")}`,
          );
        }
        draws = override;
      } else {
        const available = await this.deps.lots.listAvailable(component.itemId, input.locationId);
        if (available.length === 0) {
          if (lotControlled) {
            // Refuse rather than consume untraceably. Consuming a lot-controlled
            // material with an empty lot list produces stock nobody can recall.
            throw new Error(
              `no lots available for lot-controlled item ${component.itemId}; cannot record traceability`,
            );
          }
          draws = [];
        } else {
          draws = selectFifoLots(available, withLoss.toFixed());
        }
      }
      lotsByItem[component.itemId] = draws;

      entries.push({
        itemId: component.itemId,
        locationId: input.locationId,
        cause: "PRODUCTION_CONSUMPTION",
        onHandDelta: withoutLoss.negated().toFixed(),
        reservedDelta: "0",
        incomingDelta: "0",
        occurredAt,
        metadata: {
          batchId: input.batchId,
          lots: draws,
          // Recorded because production_batch_lots.manual_override exists to be
          // audited, and an override is a deliberate departure from FIFO.
          manualOverride: override !== undefined,
        },
      });

      if (loss.greaterThan(0)) {
        lossByItem[component.itemId] = loss.toFixed();
        entries.push({
          itemId: component.itemId,
          locationId: input.locationId,
          cause: "PROCESS_LOSS",
          onHandDelta: loss.negated().toFixed(),
          reservedDelta: "0",
          incomingDelta: "0",
          occurredAt,
          metadata: { batchId: input.batchId },
        });
      }
    }

    // Finished goods last, in the SAME command, so the ledger can never hold
    // consumption without the output it produced.
    entries.push({
      itemId: recipe.finishedItemId,
      locationId: input.locationId,
      cause: "PRODUCTION_OUTPUT",
      onHandDelta: String(input.finishedUnits),
      reservedDelta: "0",
      incomingDelta: "0",
      occurredAt,
      metadata: {
        batchId: input.batchId,
        recipeVersionId: input.recipeVersionId,
        lotsByItem,
      },
    });

    // One appendOnce: the repository commits every entry in a single
    // transaction, so a failure anywhere rolls back the whole batch.
    const appended = await this.deps.ledger.appendOnce(
      input.commandId,
      input.organizationId,
      entries,
    );

    return {
      batchId: input.batchId,
      revision: appended.revision,
      finishedUnits: input.finishedUnits,
      lotsByItem,
      lossByItem,
    };
  }
}
