CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_via TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  estimate_id TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  surface TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  UNIQUE (account_id, estimate_id)
);
CREATE TABLE IF NOT EXISTS server_events (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saves_account ON saves (account_id);
CREATE INDEX IF NOT EXISTS events_account ON server_events (account_id);
