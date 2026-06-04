# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

书童 (ShuTong) — classroom AI note-taking system. ESP32 hardware captures audio/photos → MQTT upload to cloud → HonoJS backend processes via ASR/OCR/LLM → EJS-rendered H5 web dashboard.

Two hardware variants:
- **Standard**: ESP32-WROOM, no camera, 8MB Flash
- **Flagship**: ESP32-S3 + OV2640 camera, 16MB Flash + 8MB PSRAM

## Build/Run Commands

### Server (`server/`)

```bash
npm run dev          # tsx watch — hot reload on http://localhost:3000
npm run build        # tsc → dist/
npm run start        # node dist/index.js (production)
npm run db:migrate   # Create SQLite tables (src/db/migrate.ts)
npm run db:seed      # Create admin user (admin@shutong.app / admin123)
```

The server starts even without MQTT/EMQX — MQTT connection failures are logged but non-fatal. All AI services degrade to empty string placeholders when API keys are unset.

### Firmware (`firmware/`)

```bash
idf.py set-target esp32       # Standard variant
idf.py set-target esp32s3     # Flagship variant
idf.py menuconfig              # 书童硬件配置 → select variant + set SN
idf.py build
idf.py -p /dev/cu.usbmodem101 flash monitor
```

LSP/clang errors on macOS for ESP-IDF headers (`esp_wifi.h`, `cJSON.h`, etc.) are expected — these only resolve in the ESP-IDF build environment.

## Architecture — Server

### Hono Context Typing

Custom variables are typed via `Vars` exported from `app.ts`:

```ts
// app.ts
export type Vars = {
  user: { id, email, nickname, plan, storageUsed, storageLimit };
  render: (view: string, data?) => Response;
};
const app = new Hono<{ Variables: Vars }>();

// Every route file MUST use:
import type { Vars } from '../app.js';
const app = new Hono<{ Variables: Vars }>();
```

Route handlers access user via `c.var.user` (NOT `c.get('user')`). The `render` function is attached by global middleware and accessed via `c.var.render(view, data)`.

### DrizzleORM Query Chaining

**Do NOT chain `.where()` calls.** Each `.where()` returns a different type. Build a conditions array and use `and(...)`:

```ts
// WRONG:
let q = db.select().from(notes).where(eq(notes.userId, uid));
if (courseId) q = q.where(eq(notes.courseId, courseId)); // TS error

// CORRECT:
const conds = [eq(notes.userId, uid)];
if (courseId) conds.push(eq(notes.courseId, courseId));
db.select().from(notes).where(and(...conds)).all();
```

For raw SQL queries, use `raw` (the underlying better-sqlite3 instance): `raw.prepare('SELECT ...').all(...)`.

### Authentication

- JWT stored as HttpOnly cookie (`token`), 7-day expiry, HS256 via `jose` library.
- WeChat login: proxy to `https://wx.xgrt.com.cn` — POST `/auth/wechat/qrcode` returns sessionId + QR URL, POST `/auth/wechat/verify` exchanges code for openid.
- Users created with email `{openid}@wechat.local`, empty password hash.
- Admin check: hardcoded `c.var.user.email === 'admin@shutong.app'`.

### AI Pipeline

10-second polling loop (`setInterval` in `services/queue.ts`). Pipeline: ASR → (summary + exam_points + mind_map). On ASR completion, downstream tasks are auto-created. Notes go `processing` → `ready` or `failed`.

### Storage

Dual backend: Qiniu Kodo when `QINIU_ACCESS_KEY` is set, otherwise local `data/files/`. Zero-config for local dev.

### MQTT Integration

Topic structure: `sht/{SN}/{type}`. Server subscribes to wildcards `sht/+/status`, `sht/+/audio/chunk`, `sht/+/image`. Publishes commands to `sht/{SN}/cmd` (QoS 1). Device SN extracted from topic path.

## Architecture — Firmware

### Variant Selection

Single codebase, dual variant via Kconfig. `main.c` uses `#ifdef CONFIG_SHUTONG_FLAGSHIP` guards. `CMakeLists.txt` conditionally includes `shutong_camera` component. Target chip set via `idf.py set-target`.

### Shared Components (`common/components/`)

- `shutong_wifi`: NVS credential storage → hardcoded default → AP fallback (`shutong-Setup`). Producer-consumer pattern for HTTP provisioning (volatile flags avoid event loop deadlock).
- `shutong_mqtt`: ESP-MQTT client, subscribes to `cmd` and `ota` topics, dispatches via callback.
- `shutong_audio`: I2S INMP441 at 16kHz mono, 32→16 bit conversion, circular buffer (~40s), VAD threshold 500.
- `shutong_proto`: JSON builders for all MQTT message types. Audio data is base64-encoded PCM inline in JSON.
- `shutong_camera` (flagship only): OV2640 VGA JPEG, quality 15, 20MHz XCLK.

### Key GPIO Pins

| Function | Pin | Shared? |
|---|---|---|
| Record button | GPIO 0 (BOOT) | Both |
| Status LED | GPIO 2 | Both |
| I2S SCK | GPIO 14 | Both |
| I2S WS | GPIO 21 | Both |
| I2S SD (INMP441) | GPIO 33 | Both |
| Camera button | GPIO 1 | Flagship only |
| Camera XCLK | GPIO 15 | Flagship only |
| Camera D0-D7 | 11,9,8,10,12,18,17,16 | Flagship only |

I2S pins (14, 21, 33) are chosen to avoid camera pins on ESP32-S3.

### OTA

Partition table has `factory` + `ota_0` + `ota_1`. OTA download skeleton exists in `ota_task` but is not wired — TODO.

## Deployment

Docker Compose with two services: `app` (Hono, port 13000) + `emqx` (MQTT on 1883, dashboard on 18083). Host nginx reverse-proxies `shutong.3198.net → 127.0.0.1:13000`. Config at `docker/nginx.conf`. No nginx/minio in containers — host provides nginx, Qiniu Kodo replaces MinIO.
