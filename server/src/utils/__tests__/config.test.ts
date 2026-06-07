import { describe, it, expect } from 'vitest';
import { getEnv } from '../../config.js';

describe('config', () => {
  it('returns default PORT', () => {
    const env = getEnv();
    expect(env.PORT).toBe(3000);
  });

  it('reads JWT_SECRET from environment with default', () => {
    const env = getEnv();
    expect(env.JWT_SECRET).toBeTruthy();
    expect(typeof env.JWT_SECRET).toBe('string');
  });

  it('returns expected default values', () => {
    const env = getEnv();
    expect(env.MQTT_BROKER).toBe('mqtt://127.0.0.1:1883');
    expect(typeof env.BASE_URL).toBe('string');
  });
});
