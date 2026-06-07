# AGENTS.md — 书童 (ShuTong)

Classroom AI note-taking system. ESP32 captures audio/photos → MQTT → HonoJS backend → ASR/OCR/LLM → EJS dashboard.

## Project structure

```
shutong/
├── server/          # Node.js backend (Hono + TypeScript + SQLite)
│   ├── src/
│   │   ├── index.ts           # Entry point: mounts routes, starts MQTT + HTTP
│   │   ├── app.ts             # Hono app: EJS render, static files, page routes
│   │   ├── config.ts          # Typed env var reader
│   │   ├── db/                # Drizzle ORM schema + SQLite (better-sqlite3)
│   │   ├── routes/            # 10 route files: auth, devices, courses, notes, upload, ai, export, admin, ota, knowledge
│   │   ├── services/          # mqtt, asr, ocr, llm, queue, storage, ota
│   │   ├── middleware/        # auth (JWT cookie), quota
│   │   └── utils/             # jwt (jose HS256), …
│   ├── views/                 # EJS templates (layout.ejs wraps all pages)
│   └── public/                # Static assets
├── firmware/                  # ESP-IDF C code
│   ├── main/main.c            # FreeRTOS tasks: heartbeat, record, camera, etc.
│   ├── common/components/     # Shared components
│   │   ├── shutong_wifi/      # NVS → hardcoded → AP fallback (shutong-Setup)
│   │   ├── shutong_mqtt/      # ESP-MQTT, subscribes cmd + ota
│   │   ├── shutong_audio/     # I2S INMP441 16kHz mono, circular buffer, VAD
│   │   ├── shutong_speaker/   # I2S speaker output (MAX98357)
│   │   ├── shutong_proto/     # JSON builders, base64 PCM inline
│   │   └── shutong_camera/    # OV2640 VGA JPEG (flagship only)
│   ├── partitions.csv         # factory + ota_0 + ota_1 (3 x 3MB)
│   └── Kconfig.projbuild     # Variant, SN, MQTT broker, WiFi defaults
├── docker/
│   ├── docker-compose.yml     # app (Hono) + asr (llama.cpp Qwen3-ASR) + emqx
│   ├── Dockerfile.app         # Node 22 build + run
│   ├── asr/                   # llama.cpp server serving Qwen3-ASR-0.6B GGUF
│   └── nginx.conf             # Reverse proxy shutong.3198.net → :13000
└── docs/
    ├── api.md                 # REST API reference
    └── mqtt-protocol.md       # MQTT topic + message format
```

## Commands

### Server

```bash
npm run dev          # tsx watch → http://localhost:3000
npm run build        # tsc → dist/
npm run start        # node dist/index.js (production)
npm run db:generate  # drizzle-kit generate (schema → SQL)
npm run db:migrate   # tsx src/db/migrate.ts (create tables)
npm run db:seed      # tsx src/db/seed.ts (admin: admin@shutong.app / admin123)
```

### Firmware

```bash
# Standard (ESP32-WROOM, no camera)
idf.py set-target esp32 && idf.py menuconfig && idf.py build
# Flagship (ESP32-S3 + OV2640)
idf.py set-target esp32s3 && idf.py menuconfig && idf.py build
# Flash + monitor
idf.py -p /dev/cu.usbmodem101 flash monitor
```

### Docker (full stack)

```bash
cd docker
docker compose up -d    # app:13000 + asr:8888 + emqx:1883/18083
```

## Architecture

### Server

- **Hono app** (`app.ts`): mounts EJS page routes (`c.var.render()`) and `/api/*` route modules. Global middleware attaches `render` + `X-App-Version` header. Static files at `/public/*`.
- **Auth**: JWT (HS256, jose) stored as HttpOnly cookie `token`, 7-day expiry. Auth middleware reads cookie → `c.set('user', ...)`. Admin check: `c.var.user.email === 'admin@shutong.app'`. WeChat login proxies to `https://wx.xgrt.com.cn`.
- **Storage**: Qiniu Kodo when `QINIU_ACCESS_KEY` set, else local `data/files/`.
- **AI Pipeline** (`services/queue.ts`): 10s `setInterval` poll. ASR → (summary + exam_points + mind_map) auto-cascade. Notes: `processing` → `ready`|`failed`.
- **MQTT**: Topics `sht/{SN}/{type}`. Subscribes `sht/+/status`, `sht/+/audio/chunk`, `sht/+/image`. Publishes to `sht/{SN}/cmd`.
- **ASR**: Separate docker container running llama.cpp with Qwen3-ASR-0.6B GGUF. Server POSTs WAV to `http://asr:8888/asr`.
- **10 routes**: `auth`, `devices`, `courses`, `notes`, `upload`, `ai`, `export`, `admin`, `ota`, `knowledge`.

### Firmware

- **Variants**: single codebase, `#ifdef CONFIG_SHUTONG_FLAGSHIP` guards. Kconfig selects standard/flagship + SN + MQTT broker + WiFi defaults.
- **FreeRTOS tasks**: heartbeat (30s), MQTT message handler, record (button GPIO 0), camera (GPIO 1, flagship only).
- **Key GPIOs**: Record=GPIO0, LED=GPIO3, IR_LED=GPIO47, I2S SCK=14, WS=21, SD=33, (camera: XCLK=15, D0-D7=11,9,8,10,12,18,17,16).
- **Audio**: I2S INMP441 16kHz mono, 32→16 bit, circular buffer (~40s), VAD threshold 500. Base64 PCM in JSON over MQTT.
- **Speaker**: shutong_speaker component (MAX98357 I2S amp) for playback.
- **OTA**: 3MB factory + 3MB ota_0 + 3MB ota_1 partitions. `ota_task` skeleton unwired (TODO).

## Conventions

- **Server**: ES modules (`"type": "module"`), all imports use `.js` extension. `import type { Vars } from '../app.js'` in every route file. Route handlers access user via `c.var.user`, NOT `c.get('user')`.
- **DrizzleORM**: Do NOT chain `.where()` — use `and(...conds)` with a conditions array. For raw SQL: `raw.prepare(...)`.
- **AI services**: All degrade gracefully to empty string when API keys unset. MQTT failures are logged but non-fatal.
- **Firmware**: C with ESP-IDF style (snake_case, `esp_err_t` returns, `ESP_LOGx`). Componentized under `common/components/`.
- **Errors**: Route handlers return `c.json({ error: '...' }, 4xx)`. AI tasks store error in `ai_tasks.error_msg`.
- **No tests**: No test framework or test files exist anywhere in the project.
- **No linter**: No ESLint/Prettier config — conventions enforced manually.
- **Comments**: Code comments use Chinese.
- **IDs**: UUID v4 for all primary keys (`id` fields).

## Notes

—
