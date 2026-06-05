import { getEnv } from '../config.js';

const env = getEnv();

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
    return uploadToQiniu(key, body);
  }
  return saveLocal(key, body);
}

async function uploadToQiniu(key: string, body: Buffer | Uint8Array): Promise<UploadResult> {
  const qiniu = (await import('qiniu')).default || await import('qiniu');
  const mac = new qiniu.auth.digest.Mac(env.QINIU_ACCESS_KEY, env.QINIU_SECRET_KEY);
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${env.QINIU_BUCKET}:${key}` });
  const uploadToken = putPolicy.uploadToken(mac);

  const formUploader = new qiniu.form_up.FormUploader();
  return new Promise((resolve, reject) => {
    formUploader.put(uploadToken, key, Buffer.from(body), new qiniu.form_up.PutExtra(), (err, ret) => {
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
