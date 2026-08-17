-- Lots and production batches.

CREATE TABLE IF NOT EXISTS inventory_lots (
    id                  uuid PRIMARY KEY,
    organization_id     uuid NOT NULL,
    item_id             uuid NOT NULL REFERENCES inventory_items (id),
    location_id         uuid NOT NULL,
    supplier_lot_number text,
    internal_lot_code   text,
    received_date       date NOT NULL,
    best_by_date        date,
    unit_cost           numeric(24, 8),
    /* Remaining is maintained alongside the ledger; the ledger stays authoritative. */
    received_quantity   numeric(24, 8) NOT NULL,
    remaining_quantity  numeric(24, 8) NOT NULL,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT inventory_lots_quantities_non_negative CHECK (
        received_quantity >= 0 AND remaining_quantity >= 0
    ),
    -- A lot cannot have more left than ever arrived.
    CONSTRAINT inventory_lots_remaining_within_received CHECK (remaining_quantity <= received_quantity),
    -- Best-by before receipt would break FIFO ordering and means bad data upstream.
    CONSTRAINT inventory_lots_dates_ordered CHECK (best_by_date IS NULL OR best_by_date >= received_date)
);

-- FIFO reads in exactly this order, so the index matches the sort.
CREATE INDEX IF NOT EXISTS inventory_lots_fifo_idx
    ON inventory_lots (item_id, location_id, received_date, best_by_date, id)
    WHERE remaining_quantity > 0;

CREATE TABLE IF NOT EXISTS production_batches (
    id                  uuid PRIMARY KEY,
    organization_id     uuid NOT NULL,
    recipe_version_id   uuid NOT NULL REFERENCES recipe_versions (id),
    location_id         uuid NOT NULL,
    finished_item_id    uuid NOT NULL REFERENCES inventory_items (id),
    finished_units      integer NOT NULL,
    /* The command that produced this batch; a replay must not create a second. */
    command_id          uuid NOT NULL REFERENCES processed_commands (command_id),
    status              text NOT NULL DEFAULT 'COMPLETED',
    completed_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT production_batches_units_positive CHECK (finished_units > 0),
    CONSTRAINT production_batches_status_known CHECK (status IN ('PLANNED', 'COMPLETED', 'CANCELLED')),
    -- One batch per command. This is what makes a retried completion safe.
    CONSTRAINT production_batches_command_unique UNIQUE (command_id)
);

-- Which lots a batch drew from. This is the traceability record: given a
-- finished candle, which drum of wax and which fragrance lot went into it.
CREATE TABLE IF NOT EXISTS production_batch_lots (
    id                  uuid PRIMARY KEY,
    batch_id            uuid NOT NULL REFERENCES production_batches (id) ON DELETE CASCADE,
    item_id             uuid NOT NULL REFERENCES inventory_items (id),
    lot_id              uuid NOT NULL REFERENCES inventory_lots (id),
    quantity            numeric(24, 8) NOT NULL,
    /* True when the owner overrode the FIFO proposal; overrides are audited. */
    manual_override     boolean NOT NULL DEFAULT false,

    CONSTRAINT production_batch_lots_quantity_positive CHECK (quantity > 0),
    CONSTRAINT production_batch_lots_unique UNIQUE (batch_id, item_id, lot_id)
);

CREATE INDEX IF NOT EXISTS production_batch_lots_batch_idx ON production_batch_lots (batch_id);
CREATE INDEX IF NOT EXISTS production_batch_lots_lot_idx ON production_batch_lots (lot_id);
