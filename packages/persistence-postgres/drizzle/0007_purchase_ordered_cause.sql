-- Add PURCHASE_ORDERED to the ledger's closed cause vocabulary.
--
-- Marking a purchase ordered previously posted SYNCHRONIZATION_CORRECTION, so
-- every purchase read as a sync repair and a genuine repair could not be found
-- among them. The cause list is the audit trail's vocabulary; a wrong word
-- there is a wrong record, not a cosmetic issue.
--
-- 0001 declares this CHECK inline inside CREATE TABLE IF NOT EXISTS, which is a
-- no-op on an existing database. Only DROP + ADD updates a live table.

ALTER TABLE inventory_ledger_entries
    DROP CONSTRAINT IF EXISTS inventory_ledger_entries_cause_known;

ALTER TABLE inventory_ledger_entries
    ADD CONSTRAINT inventory_ledger_entries_cause_known CHECK (cause IN (
        'RECEIPT',
        'PURCHASE_ORDERED',
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
    ));
