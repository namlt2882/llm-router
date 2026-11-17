-- +goose Up
-- Per-tick in-flight split by provider, JSON text ({"glm":2,"oc":1}). Nullable:
-- rows written before this migration have no split and chart as "unknown".
-- Numbered 005 on purpose — 003/004 stay free for the pricing-plan work.
ALTER TABLE concurrencySamples ADD COLUMN IF NOT EXISTS byProvider text;
-- +goose Down
ALTER TABLE concurrencySamples DROP COLUMN IF EXISTS byProvider;
