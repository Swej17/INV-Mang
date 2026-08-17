-- Items and versioned recipes.
--
-- Backfills what Task 5 specified but did not deliver: the capacity engine was
-- built against in-memory inputs, so nothing persisted items or recipes yet.
-- Task 7's lots and production batches reference both, so they land here.

CREATE TABLE IF NOT EXISTS inventory_items (
    id                    uuid PRIMARY KEY,
    organization_id       uuid NOT NULL,
    sku                   text NOT NULL,
    name                  text NOT NULL,
    description           text,
    active                boolean NOT NULL DEFAULT true,
    category              text NOT NULL,
    dependency_class      text NOT NULL,
    base_unit             text NOT NULL,
    display_precision     integer NOT NULL DEFAULT 2,
    lot_controlled        boolean NOT NULL DEFAULT false,
    fifo_enabled          boolean NOT NULL DEFAULT false,
    protected_quantity    numeric(24, 8),
    square_variation_id   text,
    revision              bigint NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- SKU is the human handle operators type and search by; two items sharing
    -- one inside an organization makes every such lookup ambiguous.
    CONSTRAINT inventory_items_sku_unique UNIQUE (organization_id, sku),
    CONSTRAINT inventory_items_category_known CHECK (category IN (
        'RAW_MATERIAL', 'COMPONENT', 'FINISHED_GOOD',
        'PACKING_MATERIAL', 'SHIPPING_MATERIAL', 'MISCELLANEOUS'
    )),
    -- This distinction is load-bearing: only PRODUCTION_CRITICAL constrains how
    -- many candles can be made. A typo here would let a missing shipping box
    -- halt production.
    CONSTRAINT inventory_items_dependency_known CHECK (dependency_class IN (
        'PRODUCTION_CRITICAL', 'FULFILLMENT_CRITICAL', 'ADVISORY'
    )),
    CONSTRAINT inventory_items_base_unit_known CHECK (base_unit IN ('GRAM', 'EACH', 'MILLILITER')),
    CONSTRAINT inventory_items_protected_non_negative CHECK (
        protected_quantity IS NULL OR protected_quantity >= 0
    )
);

CREATE INDEX IF NOT EXISTS inventory_items_org_active_idx
    ON inventory_items (organization_id, active);

-- Recipes are versioned, never edited in place. A finished batch records which
-- version produced it, so historical cost and traceability survive a recipe
-- change.
CREATE TABLE IF NOT EXISTS recipe_versions (
    id                    uuid PRIMARY KEY,
    organization_id       uuid NOT NULL,
    finished_item_id      uuid NOT NULL REFERENCES inventory_items (id),
    version               integer NOT NULL,
    name                  text NOT NULL,
    /* Nominal fill, for display and grouping; the components are authoritative. */
    fill_ounces           numeric(24, 8),
    active                boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    retired_at            timestamptz,

    CONSTRAINT recipe_versions_unique UNIQUE (finished_item_id, version),
    CONSTRAINT recipe_versions_version_positive CHECK (version >= 1)
);

-- Exactly one active version per finished good, enforced by the database rather
-- than by application discipline.
CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_one_active_per_item
    ON recipe_versions (finished_item_id) WHERE active;

CREATE TABLE IF NOT EXISTS recipe_components (
    id                      uuid PRIMARY KEY,
    recipe_version_id       uuid NOT NULL REFERENCES recipe_versions (id) ON DELETE CASCADE,
    item_id                 uuid NOT NULL REFERENCES inventory_items (id),
    per_unit_base           numeric(24, 8) NOT NULL,
    loss_mode               text NOT NULL DEFAULT 'NONE',
    loss_percentage         numeric(12, 8) NOT NULL DEFAULT 0,
    loss_fixed_per_batch    numeric(24, 8) NOT NULL DEFAULT 0,
    loss_batch_size         integer,

    CONSTRAINT recipe_components_unique UNIQUE (recipe_version_id, item_id),
    CONSTRAINT recipe_components_per_unit_positive CHECK (per_unit_base > 0),
    CONSTRAINT recipe_components_loss_mode_known CHECK (loss_mode IN (
        'NONE', 'PERCENT_PER_UNIT', 'FIXED_PER_BATCH', 'BOTH'
    )),
    -- Loss may only ever consume more material, never conjure it.
    CONSTRAINT recipe_components_loss_non_negative CHECK (
        loss_percentage >= 0 AND loss_fixed_per_batch >= 0
    ),
    -- A batch charge without a batch size is undefined, and a zero size would
    -- divide by zero when computing how many batches a run needs.
    CONSTRAINT recipe_components_batch_size_required CHECK (
        loss_mode IN ('NONE', 'PERCENT_PER_UNIT')
        OR (loss_batch_size IS NOT NULL AND loss_batch_size > 0)
    )
);

CREATE INDEX IF NOT EXISTS recipe_components_version_idx
    ON recipe_components (recipe_version_id);
