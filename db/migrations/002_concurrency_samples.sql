-- +goose Up
CREATE TABLE IF NOT EXISTS concurrencySamples (
  id bigserial PRIMARY KEY,
  ts text NOT NULL,
  inflight text NOT NULL,
  totalBudget text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concurrency_ts ON concurrencySamples(ts);
-- goose splits statements on ";" — without these markers it cuts the DO block
-- at the first semicolon inside the body and Postgres sees an unterminated
-- dollar-quote.
-- +goose StatementBegin
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('concurrencySamples', 'ts',
      chunk_time_interval => INTERVAL '1 day',
      time_partitioning_func => 'to_timestamp',
      if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM add_retention_policy('concurrencySamples', INTERVAL '60 days',
      if_not_exists => TRUE);
  END IF;
END $$;
-- +goose StatementEnd
-- +goose Down
SELECT remove_retention_policy('concurrencySamples', if_exists => TRUE);
DROP TABLE IF EXISTS concurrencySamples;
