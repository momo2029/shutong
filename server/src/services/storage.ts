import { getEnv } from '../config.js';
import { createRequire } from 'module';

const env = getEnv();
const require = createRequire(import.meta.url);

export interface UploadResult {
  key: string;
}

function getQiniuMac() {
  const qiniu = require('qiniu');
  return new qiniu.auth.digest.Mac(env.QINIU_ACCESS_KEY, env.QINIU_SECRET_KEY);
}

function getBucketManager() {
  const qiniu = require('qiniu');
  return new qiniu.rs.BucketManager(getQiniuMac(), null);
}

/**
 * 生成七牛云私有下载 URL（使用 SDK BucketManager.privateDownloadUrl）
 */
export function getDownloadUrl(key: string, options?: { style?: string; expiresIn?: number }): string {
  if (!env.QINIU_ACCESS_KEY || !env.QINIU_SECRET_KEY || !env.QINIU_DOMAIN) {
    return `/${key}`;
  }

  const expiresIn = options?.expiresIn ?? 86400; // 默认 24h
  const deadline = Math.floor(Date.now() / 1000) + expiresIn;
  const fileName = options?.style ? `${key}-${options.style}` : key;
  const domain = `https://${env.QINIU_DOMAIN}`;

  return getBucketManager().privateDownloadUrl(domain, fileName, deadline);
}

/**
 * 将 DB 中存储的路径转换为可访问的 URL
 */
export function getMediaUrl(path: string, options?: { style?: string; expiresIn?: number }): string {
  if (!path) return '';
  if (path.startsWith('https://') || path.startsWith('http://')) return path;
  if (path.startsWith('data/')) return `/${path}`;

  // 去掉旧的域名前缀
  const domain = env.QINIU_DOMAIN;
  if (domain && path.startsWith(`${domain}/`)) {
    path = path.slice(domain.length + 1);
  }

  if (env.QINIU_ACCESS_KEY && env.QINIU_SECRET_KEY) {
    return getDownloadUrl(path, options);
  }

  return `/${path}`;
}

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
  const qiniu = require('qiniu');
  const mac = getQiniuMac();
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${env.QINIU_BUCKET}:${key}` });
  const uploadToken = putPolicy.uploadToken(mac);

  const config = new qiniu.conf.Config();
  const formUploader = new qiniu.form_up.FormUploader(config);
  return new Promise((resolve, reject) => {
    formUploader.put(uploadToken, key, Buffer.from(body), new qiniu.form_up.PutExtra(), (err: Error | null, ret: Record<string, string>) => {
      if (err) return reject(err);
      resolve({ key: ret.key });
    });
  });
}

async function saveLocal(key: string, body: Buffer | Uint8Array): Promise<UploadResult> {
  const fs = await import('fs');
  const path = await import('path');
  const dir = path.dirname(key);
  fs.mkdirSync(`data/files/${dir}`, { recursive: true });
  fs.writeFileSync(`data/files/${key}`, body);
  return { key };
}
