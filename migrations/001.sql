CREATE TABLE IF NOT EXISTS snapshots (market text NOT NULL, key text NOT NULL, at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY(market,key));
CREATE INDEX IF NOT EXISTS snapshots_market_at ON snapshots(market,at DESC);
CREATE TABLE IF NOT EXISTS state (market text PRIMARY KEY, data jsonb NOT NULL);
