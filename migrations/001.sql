CREATE TABLE IF NOT EXISTS ah_corner_snapshots (
  market varchar(191) NOT NULL,
  snapshot_key varchar(191) NOT NULL,
  recorded_at bigint NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (market, snapshot_key),
  KEY ah_corner_snapshots_market_at (market, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ah_corner_state (
  market varchar(191) NOT NULL PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
