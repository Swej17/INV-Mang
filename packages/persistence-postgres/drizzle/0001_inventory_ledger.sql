-- Immutable inventory ledger.
--
-- Correctness lives in the database wherever it can, not only in application
-- code: a second writer, a manual psql session or a future service cannot be
-- relied on to re-implement these rules.

CREATE TABLE IF NOT EXISTS processed_commands (
    command_id      uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    -- The original response, replayed verbatim for a duplicate command so a
    -- retry observes exactly what the first attempt returned.
    result_json     jsonb NOT NULL,
    accepted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_ledger_entries (
    id                    uuid PRIMARY KEY,
    organization_id       uuid NOT NULL,
    location_id           uuid NOT NULL,
    item_id               uuid NOT NULL,
    command_id            uuid NOT NULL REFERENCES processed_commands (command_id),
    cause                 text NOT NULL,
    -- numeric, never float: 24 digits with 8 after the point covers the planned
    -- range exactly, and exactness is the entire point of this table.
    on_hand_delta         numeric(24, 8) NOT NULL DEFAULT 0,
    reserved_delta        numeric(24, 8) NOT NULL DEFAULT 0,
    incoming_delta        numeric(24, 8) NOT NULL DEFAULT 0,
    occurred_at           timestamptz NOT NULL,
    revision              bigint NOT NULL,
    compensates_event_id  uuid REFERENCES inventory_ledger_entries (id),
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT inventory_ledger_entries_cause_known CHECK (cause IN (
        'RECEIPT',
        'PHYSICAL_COUNT_ADJUSTMENT',
        'DAMAGE_OR_SPOILAGE',
        'PRODUCTION_ALLOCATION',
        'PRODUCTION_CONSUMPTION',
        'PRODUCTION_OUTPUT',
        'ORDER_RESERVATION',
        'RESERVATION_RELEASE',
        'FULFILLMENT_CONSUMPTION',
        'CUSTOMER_RETURN',
        'VENDOR_RETURN',
        'PROCESS_LOSS',
        'SYNCHRONIZATION_CORRECTION',
        'ADMINISTRATIVE_REVERSAL'
    )),
    -- An entry that moves nothing is a bug upstream, not a legitimate record.
    CONSTRAINT inventory_ledger_entries_moves_something CHECK (
        on_hand_delta <> 0 OR reserved_delta <> 0 OR incoming_delta <> 0
    )
);

CREATE INDEX IF NOT EXISTS inventory_ledger_entries_item_location_idx
    ON inventory_ledger_entries (item_id, location_id, revision);

CREATE INDEX IF NOT EXISTS inventory_ledger_entries_command_idx
    ON inventory_ledger_entries (command_id);

-- Monotonic server revision. A sequence rather than max()+1 so two concurrent
-- transactions cannot mint the same revision.
CREATE SEQUENCE IF NOT EXISTS inventory_revision_seq AS bigint START 1;

-- Posted history is append-only. Enforced by trigger rather than convention,
-- because "we agreed not to UPDATE this table" is not a guarantee.
CREATE OR REPLACE FUNCTION inventory_ledger_entries_reject_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'inventory_ledger_entries is append-only; post a compensating entry instead of %', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_ledger_entries_no_update ON inventory_ledger_entries;
CREATE TRIGGER inventory_ledger_entries_no_update
    BEFORE UPDATE OR DELETE ON inventory_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION inventory_ledger_entries_reject_mutation();

-- Derived, never stored. A view cannot drift from the entries it sums.
CREATE OR REPLACE VIEW inventory_projections AS
SELECT
    item_id,
    location_id,
    organization_id,
    COALESCE(SUM(on_hand_delta), 0)   AS on_hand,
    COALESCE(SUM(reserved_delta), 0)  AS reserved,
    COALESCE(SUM(incoming_delta), 0)  AS incoming,
    GREATEST(COALESCE(SUM(on_hand_delta), 0) - COALESCE(SUM(reserved_delta), 0), 0) AS available,
    COALESCE(MAX(revision), 0)        AS revision
FROM inventory_ledger_entries
GROUP BY item_id, location_id, organization_id;

COMMENT ON COLUMN inventory_projections.available IS
  'on_hand - reserved only. Does NOT subtract protected stock: the domain''s available is max(0, on_hand - reserved - protected). Do not promise from this column.';
