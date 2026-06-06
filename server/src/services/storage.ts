import { getEnv } from '../config.js';
import { createRequire } from 'module';

const env = getEnv();
const require = createRequire(import.meta.url);

interface UploadResult {
  key: string;
  url: string;
}

// Use local filesystem when no Qiniu credentials; otherwise use Kodo
export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array,
): Promise<UploadResult> {
  if (env.QINIU_ACCESS_KEY && env.QINIU_SECRET_KEY) {
    try {
      return await uploadToQiniu(key, body);
    } catch (e) {
      console.error('[storage] Qiniu upload failed, falling back to local:', (e as Error).message);
    }
  }
  return saveLocal(key, body);
}

function uploadToQiniu(key: string, body: Buffer | Uint8Array): Promise<UploadResult> {
  // Use require (CJS) instead of dynamic import to avoid ESM side-effects
  const qiniu = require('qiniu');
  const mac = new qiniu.auth.digest.Mac(env.QINIU_ACCESS_KEY, env.QINIU_SECRET_KEY);
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${env.QINIU_BUCKET}:${key}` });
  const uploadToken = putPolicy.uploadToken(mac);

  const config = new qiniu.conf.Config();
  const formUploader = new qiniu.form_up.FormUploader(config);
  return new Promise((resolve, reject) => {
    formUploader.put(uploadToken, key, Buffer.from(body), new qiniu.form_up.PutExtra(), (err: Error | null, ret: Record<string, string>) => {
      if (err) return reject(err);
      resolve({ key: ret.key, url: `${env.QINIU_DOMAIN}/${ret.key}` });
    });
  });
}

async function saveLocal(key: string, body: Buffer | Uint8Array): Promise<UploadResult> {
  const fs = await import('fs');
  const path = await import('path');
  const dir = path.dirname(key);
  fs.mkdirSync(`data/files/${dir}`, { recursive: true });
  fs.writeFileSync(`data/files/${key}`, body);
  return { key, url: `/data/files/${key}` };
}
