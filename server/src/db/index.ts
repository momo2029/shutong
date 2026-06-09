import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const dbPath = process.env.DB_PATH || 'data/shutong.db';
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// 自动创建表（如果不存在）
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
    plan TEXT NOT NULL DEFAULT 'free',
    storage_used INTEGER NOT NULL DEFAULT 0, storage_limit INTEGER NOT NULL DEFAULT 524288000,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, sn TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'standard',
    firmware_version TEXT NOT NULL DEFAULT '1.0.0', online INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT, short_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL, semester TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT REFERENCES devices(id),
    course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    suggested_course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    raw_transcript TEXT NOT NULL DEFAULT '', ai_summary TEXT NOT NULL DEFAULT '',
    exam_points TEXT NOT NULL DEFAULT '', mind_map TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'processing',
    audio_path TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS note_images (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL, ocr_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS firmware (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, device_type TEXT NOT NULL,
    file_path TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0,
    changelog TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    task_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    error_msg TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revision_logs (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    old_text TEXT NOT NULL DEFAULT '', new_text TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT '', chars_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 兼容迁移：已有数据库添加 role 列
try {
  sqlite.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';`);
} catch (_e) {
  // column already exists, ignore
}

// 兼容迁移：已有数据库添加 device_id 列
try {
  sqlite.exec(`ALTER TABLE notes ADD COLUMN device_id TEXT REFERENCES devices(id);`);
} catch (_e) {
  // column already exists, ignore
}

// 兼容迁移：已有数据库添加 short_url 列
try {
  sqlite.exec(`ALTER TABLE devices ADD COLUMN short_url TEXT NOT NULL DEFAULT '';`);
} catch (_e) {
  // column already exists, ignore
}

// 兼容迁移：已有数据库添加 retry_count 和 max_retries 列
try {
  sqlite.exec(`ALTER TABLE ai_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`);
} catch (_e) {
  // column already exists, ignore
}
try {
  sqlite.exec(`ALTER TABLE ai_tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;`);
} catch (_e) {
  // column already exists, ignore
}

try {
  sqlite.exec(`ALTER TABLE notes ADD COLUMN suggested_course_id TEXT REFERENCES courses(id) ON DELETE SET NULL;`);
} catch (_e) {
  // column already exists, ignore
}

export const db = drizzle(sqlite, { schema });
export const raw = sqlite as import('better-sqlite3').Database;
