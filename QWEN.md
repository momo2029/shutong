# 书童 (Shutong) 项目

## 项目概述

书童是一个智能学习硬件+云端平台产品。ESP32 设备录制音频，通过 MQTT 上传云端，服务端进行 ASR 语音转文字、AI 摘要/考点/导图生成，用户通过 Web 端管理笔记和课程。

## 架构

```
firmware/          ESP32 固件 (ESP-IDF)
  main/            主程序入口、FreeRTOS 任务
  common/components/  共享组件: wifi, mqtt, audio, speaker, camera, proto
server/            Node.js 后端 (Hono + TypeScript)
  src/routes/      10 路由: auth, devices, courses, notes, upload, ai, export, admin, ota, knowledge
  src/services/    业务服务 (MQTT, ASR, OCR, LLM, queue, OTA, 存储)
  src/db/          数据库 (Drizzle ORM + SQLite)
  views/           EJS 页面模板
docker/            Docker Compose (app + asr + EMQX)
docs/              文档 (API, MQTT 协议, 硬件烧录)
```

## 硬件版本

| 版本 | 芯片 | 摄像头 | 其他外设 | 构建目标 |
|---|---|---|---|---|
| 标准版 | ESP32-WROOM | 无 | INMP441 + MAX98357 | `idf.py set-target esp32` |
| 旗舰版 | ESP32-S3 | OV2640 | INMP441 + MAX98357 + IR LED | `idf.py set-target esp32s3` |

## ASR 服务

独立 Docker 服务 (`docker/asr/`)，使用 llama.cpp 运行 Qwen3-ASR-0.6B INT8 GGUF 模型。

- **端口**: 8888
- **API**: `POST /asr` (Content-Type: audio/wav) → `{"text": "..."}`
- **模型**: Qwen3-ASR-0.6B INT8 GGUF，存储在 `./data/asr-models/`
- **后端调用**: `server/src/services/asr.ts` 读取 WAV 文件 POST 到 ASR 服务
- **共享**: xiaobao-server 也可以调用同一个 ASR 服务（端口不冲突即可）

音频流程: 固件 PCM → Base64 → MQTT 分片 → 服务端拼接 WAV → ASR → 文本

## 常用命令

### 固件

```bash
cd firmware
# 标准版
idf.py set-target esp32 && idf.py menuconfig && idf.py build
# 旗舰版
idf.py set-target esp32s3 && idf.py menuconfig && idf.py build
# 烧录
idf.py -p /dev/cu.usbmodem101 flash monitor
```

menuconfig 中配置: 硬件版本(标准/旗舰)、设备SN、MQTT Broker URL、默认WiFi。

### 服务端

```bash
cd server
npm install
npm run dev          # 开发 (tsx watch)
npm run build        # 编译 TypeScript
npm run start        # 运行 (node dist/index.js)
npm run db:generate  # Drizzle schema 生成
npm run db:migrate   # 数据库迁移
```

### Docker (本地开发)

```bash
cd docker
docker compose up -d   # 启动 app + EMQX
```

## 服务端技术栈

- **框架**: Hono (轻量 HTTP)
- **语言**: TypeScript (ES2022, strict mode)
- **数据库**: SQLite + Drizzle ORM
- **模板**: EJS (服务端渲染)
- **认证**: JWT (httpOnly cookie) + bcryptjs
- **MQTT**: mqtt 库连接 EMQX
- **存储**: 七牛云 (qiniu SDK)
- **AI**: ASR / OCR / LLM 通过环境变量配置 API Key

## MQTT 协议要点

- Broker: EMQX, 端口 1883 (TCP) / 8083 (WebSocket)
- ClientID: `sht_<SN>` (设备端)
- 音频: PCM 16-bit 采样, Base64 传输, 按 chunk_seq 分段上传
- 图片: JPEG, Base64, 仅旗舰版
- 指令: start_record / stop_record / ping / reboot
- 详细协议见 `docs/mqtt-protocol.md`

- 详细 API 见 `docs/api.md`

## 环境变量

服务端通过环境变量配置，关键变量:

| 变量 | 说明 |
|---|---|
| PORT | 服务端口 (默认 3000) |
| JWT_SECRET | JWT 签名密钥 |
| MQTT_BROKER | MQTT Broker URL |
| QINIU_ACCESS_KEY / QINIU_SECRET_KEY | 七牛云存储 |
| QINIU_BUCKET | 七牛云 bucket |
| ASR_SERVICE_URL | 本地 ASR 服务地址 (http://asr:8888) |
| OCR_API_KEY | OCR API |
| LLM_API_KEY / LLM_API_URL | 大模型 API |

## 数据库 Schema

主要表: users, devices, courses, notes, noteImages, sessions, firmware, aiTasks

- 用户有 plan 字段 (free/member)，对应 storageLimit (默认 500MB)
- 笔记有 status 字段 (processing/ready/failed)，异步 AI 处理
- AI 任务独立表 (aiTasks)，按 taskType 区分 asr/ocr/summary/exam_points/mind_map

## 开发约定

- 固件: FreeRTOS 多任务架构（heartbeat/record/camera/MQTT handler），组件化设计，Kconfig 配置硬件参数
- GPIO: Record=GPIO0, LED=GPIO3, IR_LED=GPIO47, I2S(SCK=14, WS=21, SD=33), Camera XCLK=15
- 服务端: ES modules (`"type": "module"`)，路由文件默认导出 Hono 实例
- 数据库: Drizzle ORM，schema 定义在 `src/db/schema.ts`，迁移通过 `drizzle-kit generate`
- 页面: EJS 模板渲染，通过 `c.var.render()` 传递数据
- 代码注释使用中文
