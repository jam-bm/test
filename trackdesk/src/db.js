const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  shipper TEXT NOT NULL DEFAULT '',
  shipper_contact TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  driver_name TEXT NOT NULL,
  driver_phone TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  pickup_at INTEGER NOT NULL,
  delivery_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS check_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id),
  token TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'sms',
  sent_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE TABLE IF NOT EXISTS check_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id),
  call_id INTEGER REFERENCES check_calls(id),
  at INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  place TEXT,
  eta INTEGER,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'driver'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER,
  direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_load ON check_calls(load_id);
CREATE INDEX IF NOT EXISTS idx_checkins_load ON check_ins(load_id);
`;

const DEFAULT_SETTINGS = {
  company_name: 'My Brokerage',
  broker_phone: '',
  timezone: 'America/Chicago',
  cadence_hours: 4,
  grace_minutes: 30,
  no_response_minutes: 90,
  avg_mph: 50,
  price_per_load: 12,
};

function openDb(file = process.env.TRACKDESK_DB || 'trackdesk.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, DEFAULT_SETTINGS };
