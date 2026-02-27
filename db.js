import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, 'voice-chat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_cost (
    date TEXT PRIMARY KEY,
    total_cost REAL NOT NULL DEFAULT 0,
    input_audio_tokens INTEGER NOT NULL DEFAULT 0,
    input_text_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    output_audio_tokens INTEGER NOT NULL DEFAULT 0,
    output_text_tokens INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT (datetime('now')),
    project TEXT NOT NULL DEFAULT 'general'
  );

  CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    date TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0
  );
`);

const upsertCost = db.prepare(`
  INSERT INTO daily_cost (date, total_cost, input_audio_tokens, input_text_tokens, cached_tokens, output_audio_tokens, output_text_tokens, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(date) DO UPDATE SET
    total_cost = total_cost + excluded.total_cost,
    input_audio_tokens = input_audio_tokens + excluded.input_audio_tokens,
    input_text_tokens = input_text_tokens + excluded.input_text_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    output_audio_tokens = output_audio_tokens + excluded.output_audio_tokens,
    output_text_tokens = output_text_tokens + excluded.output_text_tokens,
    updated_at = datetime('now')
`);

const getDailyCost = db.prepare('SELECT * FROM daily_cost WHERE date = ?');
const insertSession = db.prepare('INSERT INTO sessions (id, date) VALUES (?, ?)');
const updateSession = db.prepare('UPDATE sessions SET ended_at = datetime(\'now\'), cost = ?, message_count = ? WHERE id = ?');

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addUsage(usage) {
  const ia = usage.input_token_details?.audio_tokens || 0;
  const it = usage.input_token_details?.text_tokens || 0;
  const ic = usage.input_token_details?.cached_tokens || 0;
  const oa = usage.output_token_details?.audio_tokens || 0;
  const ot = usage.output_token_details?.text_tokens || 0;
  const cost = (ia/1e6)*10 + (it/1e6)*0.6 + (ic/1e6)*0.3 + (oa/1e6)*20 + (ot/1e6)*2.4;
  
  upsertCost.run(today(), cost, ia, it, ic, oa, ot);
  return getTodayCost();
}

export function getTodayCost() {
  const row = getDailyCost.get(today());
  return row ? {
    date: row.date,
    totalCost: row.total_cost,
    tokens: {
      inputAudio: row.input_audio_tokens,
      inputText: row.input_text_tokens,
      cached: row.cached_tokens,
      outputAudio: row.output_audio_tokens,
      outputText: row.output_text_tokens,
    }
  } : { date: today(), totalCost: 0, tokens: { inputAudio: 0, inputText: 0, cached: 0, outputAudio: 0, outputText: 0 } };
}

// Messages — add image_url column if missing
try { db.exec('ALTER TABLE messages ADD COLUMN image_url TEXT'); } catch {}

const insertMsg = db.prepare('INSERT INTO messages (role, text, time, project, image_url) VALUES (?, ?, ?, ?, ?)');
const getMessages = db.prepare('SELECT id, role, text, time, project, image_url FROM messages ORDER BY id DESC LIMIT ?');
const getMessagesBefore = db.prepare('SELECT id, role, text, time, project, image_url FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?');
const clearMessages = db.prepare('DELETE FROM messages');

export function addMessage(role, text, project = 'general', imageUrl = null) {
  insertMsg.run(role, text, new Date().toISOString(), project, imageUrl);
}

export function getHistory(limit = 50, before = null) {
  const rows = before ? getMessagesBefore.all(before, limit) : getMessages.all(limit);
  return rows.reverse();
}

export function clearHistory() {
  clearMessages.run();
}

// Preferences
const getPref = db.prepare('SELECT value FROM preferences WHERE key = ?');
const setPref = db.prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)');

export function getPreference(key) {
  const row = getPref.get(key);
  return row ? row.value : null;
}

export function setPreference(key, value) {
  setPref.run(key, value);
}

export function startSession(id) {
  insertSession.run(id, today());
}

export function endSession(id, cost, messageCount) {
  updateSession.run(cost, messageCount, id);
}
