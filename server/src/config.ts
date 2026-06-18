const env = {
  PORT: parseInt(process.env.PORT || '3000') || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'shutong-dev-secret-change-in-prod',
  MQTT_BROKER: process.env.MQTT_BROKER || 'mqtt://127.0.0.1:1883',
  MQTT_USER: process.env.MQTT_USER || '',
  MQTT_PASSWORD: process.env.MQTT_PASSWORD || '',
  DEVICE_MASTER_KEY: process.env.DEVICE_MASTER_KEY || '',
  EMQX_API_USER: process.env.EMQX_API_USER || process.env.EMQX_API_KEY || '',
  EMQX_API_PASSWORD: process.env.EMQX_API_PASSWORD || process.env.EMQX_API_SECRET || '',
  EMQX_API_URL: process.env.EMQX_API_URL || '',
  EMQX_API_PORT: process.env.EMQX_API_PORT || '',
  DB_PATH: process.env.DB_PATH || 'data/shutong.db',
  QINIU_ACCESS_KEY: process.env.QINIU_ACCESS_KEY || '',
  QINIU_SECRET_KEY: process.env.QINIU_SECRET_KEY || '',
  QINIU_BUCKET: process.env.QINIU_BUCKET || 'shutong-media',
  QINIU_DOMAIN: process.env.QINIU_DOMAIN || '',
  QINIU_IMAGE_STYLE: process.env.QINIU_IMAGE_STYLE || '',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  ASR_API_KEY: process.env.ASR_API_KEY || '',
  ASR_SERVICE_URL: process.env.ASR_SERVICE_URL || '',
  OCR_API_KEY: process.env.OCR_API_KEY || '',
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_API_URL: process.env.LLM_API_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
  LLM_MODEL: process.env.LLM_MODEL || 'mimo-v2.5-pro',
  TTS_MODEL: process.env.TTS_MODEL || 'FunAudioLLM/CosyVoice2-0.5B',
  ALLOW_FIRST_USER_ADMIN: process.env.ALLOW_FIRST_USER_ADMIN === 'true',
  // CORS 白名单，逗号分隔。低代码平台/App 域名加这里
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
};

export function getEnv() {
  return env;
}

export function validateProductionConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return;

  const errors: string[] = [];
  if (!process.env.JWT_SECRET || env.JWT_SECRET === 'shutong-dev-secret-change-in-prod' || env.JWT_SECRET === 'change-me-in-production') {
    errors.push('JWT_SECRET must be set to a strong production secret');
  }
  if (!env.DEVICE_MASTER_KEY) {
    errors.push('DEVICE_MASTER_KEY must be set for production device authentication');
  }
  if (!env.QINIU_ACCESS_KEY || !env.QINIU_SECRET_KEY || !env.QINIU_DOMAIN) {
    errors.push('QINIU_ACCESS_KEY, QINIU_SECRET_KEY and QINIU_DOMAIN must be set in production');
  }
  if (!env.BASE_URL.startsWith('https://')) {
    errors.push('BASE_URL must use https:// in production');
  }
  if (!env.MQTT_USER || !env.MQTT_PASSWORD) {
    errors.push('MQTT_USER and MQTT_PASSWORD must be set in production');
  }
  if (!env.EMQX_API_USER || !env.EMQX_API_PASSWORD) {
    errors.push('EMQX_API_USER and EMQX_API_PASSWORD must be set in production');
  }
  if (env.ALLOW_FIRST_USER_ADMIN) {
    errors.push('ALLOW_FIRST_USER_ADMIN must not be enabled in production');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid production config:\n- ${errors.join('\n- ')}`);
  }
}

export type Env = typeof env;
