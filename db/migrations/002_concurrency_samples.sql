-- +goose Up
CREATE TABLE IF NOT EXISTS concurrencySamples (
  id bigserial PRIMARY KEY,
  ts text NOT NULL,
  inflight text NOT NULL,
  totalBudget text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concurrency_ts ON concurrencySamples(ts);
-- The partitioning function for the TEXT ISO-8601 `ts` column. Two reasons it
-- is not `to_timestamp`: the bare name is ambiguous on the timescaledb image
-- (42725, "more than one function named") because create_hypertable resolves
-- it through regproc without a signature; and the resolvable overload takes
-- double precision, which a text column cannot reach without a cast. A
-- dedicated wrapper takes the column type directly and resolves uniquely.
-- Live-verified 2026-11-17: the bare name failed the dev cutover's migrate.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION concurrency_ts(text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS 'SELECT $1::timestamptz';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- Timescale can only enforce a unique constraint that CONTAINS the
    -- partitioning column (TS103 on the (id)-only PK), so on the hypertable
    -- the SQLite-mirror PK becomes (id, ts); on vanilla Postgres the declared
    -- PK stands unchanged. INSERTs never set id (bigserial default) and are
    -- never upserted, so the wider PK costs nothing.
    ALTER TABLE concurrencySamples DROP CONSTRAINT IF EXISTS concurrencySamples_pkey;
    PERFORM create_hypertable('concurrencySamples', 'ts',
      chunk_time_interval => INTERVAL '1 day',
      time_partitioning_func => 'concurrency_ts',
      if_not_exists => TRUE, migrate_data => TRUE);
    ALTER TABLE concurrencySamples ADD PRIMARY KEY (id, ts);
    PERFORM add_retention_policy('concurrencySamples', INTERVAL '60 days',
      if_not_exists => TRUE);
  END IF;
END $$;
-- +goose StatementEnd
-- +goose Down
SELECT remove_retention_policy('concurrencySamples', if_exists => TRUE);
DROP TABLE IF EXISTS concurrencySamples;
DROP FUNCTION IF EXISTS concurrency_ts(text);
