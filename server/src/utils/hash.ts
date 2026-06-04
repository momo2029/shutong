import bcrypt from 'bcryptjs';

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export async function comparePassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}
