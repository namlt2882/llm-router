-- +goose Up
-- Request identity for the credit wallet: the WaveBot hold id that admitted the
-- request, and the credits the router charged for that attempt (decimal text).
-- Nullable: rows written before this migration, and calls made outside a hold,
-- carry neither. Numbered 003 as reserved for the pricing-plan work. No index:
-- the mirror is index-free by design; the in-memory SQLite keeps idx_uh_hold.
ALTER TABLE usageHistory ADD COLUMN IF NOT EXISTS holdId text;
ALTER TABLE usageHistory ADD COLUMN IF NOT EXISTS costCredits text;
-- +goose Down
ALTER TABLE usageHistory DROP COLUMN IF EXISTS costCredits;
ALTER TABLE usageHistory DROP COLUMN IF EXISTS holdId;
