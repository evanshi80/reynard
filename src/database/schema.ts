export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  room_id TEXT,
  room_name TEXT,
  talker_id TEXT,
  talker_name TEXT,
  content TEXT,
  message_type TEXT,
  timestamp INTEGER,
  raw_data TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_talker_id ON messages(talker_id);
CREATE INDEX IF NOT EXISTS idx_message_id ON messages(message_id);
`;
