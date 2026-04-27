CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  access_token TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  last_status TEXT DEFAULT 'idle',
  last_message TEXT DEFAULT '',
  last_checkin_at TEXT,
  last_success_at TEXT,
  last_http_status INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_name ON sites(name);

CREATE TABLE IF NOT EXISTS checkin_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER,
  site_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  quota_awarded TEXT,
  response_message TEXT,
  response_body TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_requested_at ON checkin_runs(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_site_id ON checkin_runs(site_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
