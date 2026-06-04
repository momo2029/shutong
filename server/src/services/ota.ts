import { db } from '../db/index.js';
import { firmware } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export function getLatestFirmware(deviceType: string) {
  return db.select()
    .from(firmware)
    .where(eq(firmware.deviceType, deviceType))
    .orderBy(firmware.createdAt)
    .get();
}

export function getFirmwareList(deviceType?: string) {
  if (deviceType) {
    return db.select().from(firmware).where(eq(firmware.deviceType, deviceType)).all();
  }
  return db.select().from(firmware).all();
}
