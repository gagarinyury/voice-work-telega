-- Database schema for Equipment Journal

-- Users table (Telegram ID -> Surname mapping)
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  surname TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Journal entries table
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  surname TEXT NOT NULL,
  date DATE NOT NULL,
  rounds TEXT, -- JSON array of times ["08:10", "12:15"]
  events TEXT, -- JSON array of events [{"time": "07:05", "description": "..."}]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal(date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_telegram_id ON journal(telegram_id);
