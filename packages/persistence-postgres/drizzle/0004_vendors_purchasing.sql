-- Vendors and inbound purchases.
--
-- NUMBERING DEVIATION: the plan calls this 0005 and reserves 0004 for orders
-- and packing, which Task 8 did not deliver. Migrations apply in lexical order,
-- so leaving a hole would let a later-added 0004 run AFTER this file and break
-- any dependency between them. Orders/packing becomes 0005.

CREATE TABLE IF NOT EXISTS vendors (
    id                  uuid PRIMARY KEY,
    organization_id     uuid NOT NULL,
    name                text NOT NULL,
    contact_name        text,
    notes               text,
    active              boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendors_name_unique UNIQUE (organization_id, name)
);

-- What one vendor charges for one item. Separate from the vendor so an item can
-- have several offers and the recommendation can name alternates.
CREATE TABLE IF NOT EXISTS vendor_offers (
    id                      uuid PRIMARY KEY,
    organization_id         uuid NOT NULL,
    vendor_id               uuid NOT NULL REFERENCES vendors (id),
    item_id                 uuid NOT NULL REFERENCES inventory_items (id),
    preferred               boolean NOT NULL DEFAULT false,
    product_url             text,
    vendor_sku              text,
    /* Base units delivered per purchase unit: a 10 lb wax case is 4535.9237 g. */
    pack_conversion         numeric(24, 8) NOT NULL,
    pack_size               numeric(24, 8) NOT NULL DEFAULT 1,
    minimum_order_quantity  numeric(24, 8) NOT NULL DEFAULT 0,
    reorder_multiple        numeric(24, 8) NOT NULL DEFAULT 1,
    unit_price              numeric(18, 4) NOT NULL,
    lead_time_days          integer NOT NULL DEFAULT 0,
    shipping_estimate       numeric(18, 4) NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_offers_unique UNIQUE (vendor_id, item_id),
    -- A zero conversion divides by zero when sizing an order.
    CONSTRAINT vendor_offers_conversion_positive CHECK (pack_conversion > 0),
    CONSTRAINT vendor_offers_non_negative CHECK (
        pack_size >= 0 AND minimum_order_quantity >= 0 AND reorder_multiple >= 0
        AND unit_price >= 0 AND shipping_estimate >= 0 AND lead_time_days >= 0
    )
);

-- Exactly one preferred offer per item, enforced here rather than by convention.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_offers_one_preferred_per_item
    ON vendor_offers (item_id) WHERE preferred;

-- Price history, kept because a recommendation that cites a price should be
-- auditable against what that price actually was at the time.
CREATE TABLE IF NOT EXISTS vendor_price_history (
    id              uuid PRIMARY KEY,
    vendor_offer_id uuid NOT NULL REFERENCES vendor_offers (id) ON DELETE CASCADE,
    unit_price      numeric(18, 4) NOT NULL,
    observed_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_price_history_non_negative CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS vendor_price_history_offer_idx
    ON vendor_price_history (vendor_offer_id, observed_at DESC);

-- An expected inbound. This system never places an external order; marking a
-- recommendation ordered records an intent so incoming stock can be planned for.
CREATE TABLE IF NOT EXISTS purchase_orders (
    id                  uuid PRIMARY KEY,
    organization_id     uuid NOT NULL,
    vendor_id           uuid NOT NULL REFERENCES vendors (id),
    item_id             uuid NOT NULL REFERENCES inventory_items (id),
    location_id         uuid NOT NULL,
    /* Purchase units ordered, not base units. */
    ordered_quantity    numeric(24, 8) NOT NULL,
    pack_conversion     numeric(24, 8) NOT NULL,
    expected_arrival    date,
    actual_cost         numeric(18, 4),
    status              text NOT NULL DEFAULT 'ORDERED',
    command_id          uuid NOT NULL REFERENCES processed_commands (command_id),
    ordered_at          timestamptz NOT NULL DEFAULT now(),
    received_at         timestamptz,

    CONSTRAINT purchase_orders_quantity_positive CHECK (ordered_quantity > 0),
    CONSTRAINT purchase_orders_conversion_positive CHECK (pack_conversion > 0),
    CONSTRAINT purchase_orders_status_known CHECK (status IN ('ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
    -- One inbound per command, so a retried "mark ordered" cannot double the
    -- expected quantity and inflate future availability.
    CONSTRAINT purchase_orders_command_unique UNIQUE (command_id),
    CONSTRAINT purchase_orders_received_has_time CHECK (
        status <> 'RECEIVED' OR received_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS purchase_orders_open_idx
    ON purchase_orders (item_id, location_id) WHERE status IN ('ORDERED', 'PARTIAL');
