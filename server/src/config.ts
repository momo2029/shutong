const env = {
  PORT: parseInt(process.env.PORT || '3000'),
  JWT_SECRET: process.env.JWT_SECRET || 'shutong-dev-secret-change-in-prod',
  MQTT_BROKER: process.env.MQTT_BROKER || 'mqtt://127.0.0.1:1883',
  MQTT_USER: process.env.MQTT_USER || '',
  MQTT_PASSWORD: process.env.MQTT_PASSWORD || '',
  QINIU_ACCESS_KEY: process.env.QINIU_ACCESS_KEY || '',
  QINIU_SECRET_KEY: process.env.QINIU_SECRET_KEY || '',
  QINIU_BUCKET: process.env.QINIU_BUCKET || 'shutong-media',
  QINIU_DOMAIN: process.env.QINIU_DOMAIN || '',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  ASR_API_KEY: process.env.ASR_API_KEY || '',
  ASR_SERVICE_URL: process.env.ASR_SERVICE_URL || '',
  OCR_API_KEY: process.env.OCR_API_KEY || '',
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_API_URL: process.env.LLM_API_URL || '',
  DEVICE_MASTER_KEY: process.env.DEVICE_MASTER_KEY || '',
};

export function getEnv() {
  return env;
}

export type Env = typeof env;
