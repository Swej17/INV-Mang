-- Give the traceability records the same protection as the ledger they explain.
--
-- production_batch_lots answers "which drum of wax went into this candle" — the
-- question a recall turns on. As written in 0003 it was weaker than the ledger
-- it traces: freely UPDATE-able and DELETE-able, and cascading from
-- production_batches, so removing one batch row erased every lot linkage while
-- the PRODUCTION_CONSUMPTION entries survived. That leaves stock provably
-- consumed with nothing left to say what it was consumed from — the ledger
-- stays honest and the trace silently disappears.
--
-- 0003 declares these inline in CREATE TABLE IF NOT EXISTS, so re-running it
-- changes nothing on a live database. Only ALTER reaches an existing table.

-- 1. A batch that has been traced cannot be deleted out from under its trace.
--    Cancelling a batch is a status change plus compensating ledger entries,
--    never a DELETE, so nothing legitimate needs the cascade.
ALTER TABLE production_batch_lots
    DROP CONSTRAINT IF EXISTS production_batch_lots_batch_id_fkey;

ALTER TABLE production_batch_lots
    ADD CONSTRAINT production_batch_lots_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES production_batches (id) ON DELETE RESTRICT;

-- 2. Traceability is append-only, for the same reason the ledger is: "we agreed
--    not to UPDATE this table" is not a guarantee.
CREATE OR REPLACE FUNCTION production_batch_lots_reject_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'production_batch_lots is append-only; correct a batch with a compensating entry instead of %', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS production_batch_lots_no_mutation ON production_batch_lots;
CREATE TRIGGER production_batch_lots_no_mutation
    BEFORE UPDATE OR DELETE ON production_batch_lots
    FOR EACH ROW EXECUTE FUNCTION production_batch_lots_reject_mutation();

-- 3. inventory_lots is NOT append-only, and must not be: remaining_quantity
--    falls every time the lot is drawn from, and best-by dates and notes get
--    corrected from the supplier's paperwork. What must never change is the
--    lot's identity — which item it is, whose it is, where it sits, when it
--    arrived and how much did. Those are the columns a trace resolves through,
--    so rewriting one silently re-points every finished candle already linked
--    to this lot at different material.
CREATE OR REPLACE FUNCTION inventory_lots_reject_identity_change()
RETURNS trigger AS $$
BEGIN
    IF NEW.id <> OLD.id
        OR NEW.organization_id <> OLD.organization_id
        OR NEW.item_id <> OLD.item_id
        OR NEW.location_id <> OLD.location_id
        OR NEW.received_date <> OLD.received_date
        OR NEW.received_quantity <> OLD.received_quantity
    THEN
        RAISE EXCEPTION 'inventory_lots identity is immutable; received stock cannot be reassigned after the fact';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_lots_identity_immutable ON inventory_lots;
CREATE TRIGGER inventory_lots_identity_immutable
    BEFORE UPDATE ON inventory_lots
    FOR EACH ROW EXECUTE FUNCTION inventory_lots_reject_identity_change();
