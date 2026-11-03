-- Keep the legacy numeric subtotal while explicitly marking unreported native usage.
ALTER TABLE usage_records ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 1 CHECK(usage_known IN (0,1));
