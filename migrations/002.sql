CREATE TABLE IF NOT EXISTS ah_corner_price_history (
  market varchar(191) NOT NULL,
  snapshot_key varchar(191) NOT NULL,
  item_id bigint NOT NULL,
  source varchar(16) NOT NULL,
  hour_bucket bigint NOT NULL,
  recorded_at bigint NOT NULL,
  floor_price bigint NOT NULL,
  median_price bigint NOT NULL,
  units bigint NOT NULL,
  listing_count bigint NOT NULL,
  PRIMARY KEY (market, item_id, hour_bucket),
  KEY ah_corner_history_item_time (market, item_id, recorded_at),
  KEY ah_corner_history_expiry (source, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
