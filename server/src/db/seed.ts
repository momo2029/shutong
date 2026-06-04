import { db } from './index.js';
import { users } from './schema.js';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';

// Create tables if not exist via drizzle's push strategy — run migrations for prod
const seed = async () => {
  const id = uuid();
  const hash = await bcrypt.hash('admin123', 10);
  db.insert(users).values({
    id,
    email: 'admin@shutong.app',
    passwordHash: hash,
    nickname: 'Admin',
    plan: 'member',
    storageLimit: 10737418240, // 10GB
  }).run();
  console.log('Seed done: admin@shutong.app / admin123');
};

seed();
