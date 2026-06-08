import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull().default(''),
  role: text('role').notNull().default('user'), // user | admin
  plan: text('plan').notNull().default('free'), // free | member
  storageUsed: integer('storage_used').notNull().default(0),
  storageLimit: integer('storage_limit').notNull().default(524288000), // 500MB
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  sn: text('sn').notNull().unique(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull().default(''),
  type: text('type').notNull().default('standard'), // standard | flagship
  firmwareVersion: text('firmware_version').notNull().default('1.0.0'),
  online: integer('online').notNull().default(0),
  lastSeen: text('last_seen'),
  shortUrl: text('short_url').notNull().default(''),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
});

export const courses = sqliteTable('courses', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  semester: text('semester').notNull().default(''),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
});

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  deviceId: text('device_id').references(() => devices.id),
  courseId: text('course_id').references(() => courses.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  rawTranscript: text('raw_transcript').notNull().default(''),
  aiSummary: text('ai_summary').notNull().default(''),
  examPoints: text('exam_points').notNull().default(''),
  mindMap: text('mind_map').notNull().default(''),
  tags: text('tags').notNull().default(''),
  status: text('status').notNull().default('processing'), // processing | ready | failed
  audioPath: text('audio_path').notNull().default(''),
  duration: integer('duration').notNull().default(0),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
});

export const noteImages = sqliteTable('note_images', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  imagePath: text('image_path').notNull(),
  ocrText: text('ocr_text').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
});

export const firmware = sqliteTable('firmware', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  deviceType: text('device_type').notNull(), // standard | flagship
  filePath: text('file_path').notNull(),
  fileSize: integer('file_size').notNull().default(0),
  changelog: text('changelog').notNull().default(''),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (t) => ({
  uniq: unique().on(t.version, t.deviceType),
}));

export const aiTasks = sqliteTable('ai_tasks', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  taskType: text('task_type').notNull(), // asr | ocr | summary | exam_points | mind_map
  status: text('status').notNull().default('pending'), // pending | running | done | failed
  errorMsg: text('error_msg').notNull().default(''),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
});

export const revisionLogs = sqliteTable('revision_logs', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  oldText: text('old_text').notNull().default(''),
  newText: text('new_text').notNull().default(''),
  stage: text('stage').notNull().default(''), // 'asr' | 'polish_chunk' | 'polish_final'
  charsChanged: integer('chars_changed').notNull().default(0),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
});
