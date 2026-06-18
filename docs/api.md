# 书童 API 对接文档（低代码平台 / App）

Base URL: `https://shutong.3198.net/api`

文档版本: 2026-06-18

## 1. 鉴权

### 1.1 Token 获取

调用 `POST /api/auth/login` 或 `POST /api/auth/wechat/verify` 拿到 `token` 字段。所有需要登录的接口都通过该 token 鉴权。

### 1.2 Token 携带方式（两种都支持）

- **Authorization Header（推荐 App/低代码平台用）**：
  ```
  Authorization: Bearer <token>
  ```
- **Cookie（浏览器网页用）**：`Cookie: token=<token>`（HttpOnly, 7 天）

### 1.3 CORS 跨域

服务端白名单来自环境变量 `CORS_ORIGINS`（逗号分隔）。
- 预检 `OPTIONS` 已自动响应
- 允许的请求头：`Authorization`, `Content-Type`
- 允许的方法：`GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`
- 允许携带凭证

**接入方需要把调用方域名加进生产环境的 `CORS_ORIGINS`**，否则浏览器侧会被拦。联系管理员修改 `/opt/shutong/docker/.env`。

### 1.4 限流

`/api/*` 全局 100 req/min/IP，超出返回 429。

### 1.5 统一响应格式

成功：
```json
{ "ok": true, ...其他字段 }
```

失败：
```json
{ "error": "错误描述" }
```

HTTP 状态码：200 成功 / 400 参数错误 / 401 未登录 / 403 权限不足 / 404 不存在 / 409 冲突 / 429 限流 / 500 服务器错误。

---

## 2. Auth 认证

### POST /api/auth/login
邮箱密码登录（管理端 / 开发用）。

**Body** (JSON):
```json
{ "email": "admin@shutong.app", "password": "admin123" }
```

**Response**:
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "123",
    "email": "admin@shutong.app",
    "nickname": "管理员",
    "role": "admin",
    "plan": "pro"
  }
}
```

### POST /api/auth/wechat/qrcode
获取微信扫码登录二维码（小程序码）。

**Body**: `{}`

**Response**: 服务端透传 `https://wx.3198.net/auth/wechat/qrcode` 的结果，包含 `sessionId` 和二维码图片 URL。

### POST /api/auth/wechat/verify
验证微信扫码登录，返回 JWT。

**Body** (JSON):
```json
{ "sessionId": "<上一步拿到的>", "code": "用户输入的验证码" }
```

**Response**: 同 `/login`。

### POST /api/auth/logout
登出，清除 cookie。

### GET /api/auth/me
获取当前登录用户信息（无需 body，靠 token 鉴权）。

**Response**:
```json
{
  "user": {
    "id": "123",
    "email": "...",
    "nickname": "...",
    "role": "user",
    "plan": "free"
  }
}
```
未登录返回 `{ "user": null }`。

---

## 3. Schedule 课表（核心模块）

课表是按周×节次的时间索引层，用于自动定位"当前/下一节课"，开录音时自动关联课程。

### GET /api/schedule
列出当前用户的周课表（含课程名）。

**Response**:
```json
{
  "slots": [
    {
      "id": "snowflake-id",
      "user_id": "...",
      "weekday": 1,            // 1=周一 ... 7=周日
      "slot_index": 1,          // 第几节，1-based
      "start_time": "09:00",    // HH:MM
      "end_time": "09:45",
      "course_id": "course-id",
      "course_name": "数学",
      "classroom": "教室A",
      "teacher": "张老师",
      "created_at": "2026-06-18 10:00:00"
    }
  ]
}
```

### PUT /api/schedule
批量保存整周课表（删旧插新，事务包裹）。

**Body** (JSON):
```json
{
  "slots": [
    {
      "weekday": 1,
      "slotIndex": 1,
      "startTime": "09:00",
      "endTime": "09:45",
      "courseId": "course-id",
      "classroom": "教室A",
      "teacher": "张老师"
    }
  ]
}
```

**校验规则**：
- `weekday`: 1-7 整数
- `slotIndex`: 1-30 整数
- `startTime` / `endTime`: `HH:MM` 24小时制
- `startTime < endTime`
- `courseId` 为空则跳过该条

**Response**: 同 `GET /api/schedule`，返回保存后的全量 slots。

### GET /api/schedule/current?now=ISO
计算当前正在上的课和下一节课。`now` 可选，默认服务器当前时间（Asia/Shanghai 时区）。

**Response**:
```json
{
  "weekday": 3,
  "current": {
    "id": "...",
    "weekday": 3,
    "slot_index": 2,
    "start_time": "10:00",
    "end_time": "10:45",
    "course_id": "...",
    "course_name": "数学",
    "classroom": "教室A",
    "teacher": "张老师",
    "elapsedMin": 12   // 已经上了多少分钟
  },
  "next": {
    "id": "...",
    "course_name": "物理",
    "start_time": "11:00",
    "waitMin": 15,    // 距离开始还有多少分钟
    ...
  }
}
```

`current` 或 `next` 为 `null` 表示当前没课 / 今天剩余没课。

---

## 4. Courses 课程

### GET /api/courses
```json
{
  "courses": [
    { "id": "...", "name": "数学", "semester": "2026春", "description": "..." }
  ]
}
```

### GET /api/courses/:id
单条课程详情。

### POST /api/courses
**Body** (form 或 JSON 都行，建议 JSON):
```json
{ "name": "数学", "semester": "2026春", "description": "高中数学" }
```
**Response**: `{ "ok": true, "id": "..." }`

### PUT /api/courses/:id
更新课程，字段同上。

### DELETE /api/courses/:id
删除课程。关联的 schedule_slots.course_id 会被置空，notes.course_id 不动。

---

## 5. Notes 笔记

### GET /api/notes?course=&status=&q=&page=
笔记列表。

**Query**:
- `course`: 按 courseId 筛选
- `status`: `processing` / `ready` / `failed` / `paused`
- `q`: 在 rawTranscript 中模糊搜索
- `page`: 分页，默认 1，每页 20 条

**Response**:
```json
{
  "notes": [
    {
      "id": "...",
      "userId": "...",
      "title": "数学课笔记",
      "audioPath": "audio/xxx.opus",
      "rawTranscript": "...",
      "aiSummary": "Markdown 格式",
      "examPoints": "...",
      "mindMap": "...",
      "tags": "数学,函数,导数",
      "status": "ready",
      "courseId": "...",
      "scheduleSlotId": "...",
      "suggestedCourseId": null,
      "duration": 3600,
      "createdAt": "2026-06-18T10:00:00.000Z",
      "updatedAt": "..."
    }
  ],
  "total": 82,
  "page": 1
}
```

### GET /api/notes/:id
笔记详情，含 images / AI 任务状态 / 修订历史。

```json
{
  "note": { /* 同上 */ },
  "images": [{ "id": "...", "imagePath": "...", "ocrText": "...", "sortOrder": 0 }],
  "tasks": [{ "id": "...", "taskType": "asr", "status": "done", "errorMsg": "" }],
  "revisions": [{ "stage": "asr", "oldText": "...", "newText": "...", "charsChanged": 12, "createdAt": "..." }]
}
```

### POST /api/notes
创建笔记。两种模式：

#### 模式 A：录音开始即建笔记（JSON）
```json
{
  "title": "数学课笔记",            // 可选，默认"网页录音笔记"
  "scheduleSlotId": "slot-id",      // 可选，自动解析 courseId
  "courseId": "course-id"           // 可选，显式指定优先
}
```
返回 `{ "ok": true, "id": "noteId" }`，之后用 `/:id/chunk` 分块上传音频。

#### 模式 B：完整音频一次性上传（FormData）
字段：
- `audio`: 文件（webm/wav/mp3 等，≤50MB）
- `title`: 可选
- `scheduleSlotId`: 可选
- `courseId`: 可选
- `transcript`: 可选，浏览器预转写文本

### POST /api/notes/:id/chunk
录音中分块上传（每分钟一段）。

**Body** (FormData):
- `audio`: 当前块音频
- `transcript`: 累计全量转写文本
- `chunk`: 块序号，整数

### POST /api/notes/:id/viewing
前端轮询标记"正在查看此笔记"（控制设备实时转写频率）。

### POST /api/notes/:id/stop-recording
向设备发送 stop_record 命令（仅设备绑定的笔记可用）。

### POST /api/notes/:id/resume-recording
向设备发送 start_record 命令（设备创建新笔记继续）。

### POST /api/notes/:id/capture
向设备发送拍照指令。

### POST /api/notes/:id/reprocess
重新触发 ASR + 下游 AI 任务。笔记状态置回 `processing`。

### POST /api/notes/:id/confirm-course
确认 AI 建议的课程（把 suggestedCourseId 写入 courseId）。

### POST /api/notes/:id/dismiss-course
忽略 AI 建议的课程。

### PUT /api/notes/:id/course
手动关联课程。

**Body**: `{ "courseId": "..." }`（传 null 清除关联）

### DELETE /api/notes/:id
删除笔记 + 关联图片 + 本地音频文件。

---

## 6. Upload 上传（独立通道）

### POST /api/upload/audio
独立音频上传（不创建笔记）。
- FormData field: `audio`
- 限制：≤50MB，audio/* 类型
- Response: `{ "ok": true, "id": "noteId" }`（会自动建笔记并触发 ASR）

### POST /api/upload/image
独立图片上传。
- FormData fields: `image`, `noteId`
- 限制：≤10MB，image/* 类型
- Response: `{ "ok": true, "id": "imageId", "url": "下载URL" }`

---

## 7. Devices 设备

### GET /api/devices
当前用户绑定的设备列表。
```json
{
  "devices": [
    {
      "id": "...",
      "sn": "ST20260618AABBCC",
      "name": "我的书童",
      "type": "standard",
      "online": true,
      "lastSeenAt": "..."
    }
  ]
}
```

### POST /api/devices/bind
绑定设备。
**Body**: `{ "sn": "设备序列号", "name": "我的书童" }`
**Response**: `{ "ok": true, "id": "deviceId" }`
冲突返回 409。

### DELETE /api/devices/:id
解绑设备。

### POST /api/devices/:id/cmd
向设备发送命令（MQTT）。

**Body**:
```json
{ "cmd": "start_record", "params": { /* 可选 */ } }
```

支持的 cmd:
- `start_record` / `stop_record` — 开始/停止录音
- `capture` — 拍照
- `ota` — 推送最新固件（服务端自动填 url+version）
- `reboot` — 重启

设备离线返回 400。MQTT 未连接返回 503。

---

## 8. AI 任务

### GET /api/ai/tasks/:noteId
某笔记的全部 AI 任务状态。
```json
{
  "tasks": [
    { "id": "...", "taskType": "asr", "status": "done", "retryCount": 0, "errorMsg": "" },
    { "taskType": "summary", "status": "pending" }
  ]
}
```

### POST /api/ai/summary/:noteId
单独触发摘要重生成。

### POST /api/ai/exam/:noteId
单独触发考点重生成。

### POST /api/ai/mindmap/:noteId
单独触发思维导图重生成。

---

## 9. Knowledge 知识库

### GET /api/knowledge/search?q=keyword
在所有笔记的 raw_transcript 中搜索。
```json
{
  "results": [
    { "id": "...", "title": "...", "snippet": "...前200字...", "status": "ready", "created_at": "..." }
  ]
}
```

### POST /api/knowledge/ask
基于最近 10 条已处理笔记做 RAG 问答。
**Body**: `{ "question": "函数的导数定义是什么？" }`
**Response**: `{ "answer": "..." }`

---

## 10. Export 导出

### GET /api/export/note/:id/pdf
导出笔记为 HTML（带 `Content-Disposition: attachment`，浏览器会下载）。

### GET /api/export/note/:id/docx
导出为 Word（.doc，含 Word 命名空间）。

---

## 11. 媒体 URL 签名

笔记和图片的 `audioPath` / `imagePath` 字段存储的是对象存储 key，**不能直接当 URL 用**。需要通过以下方式获取签名 URL：

- 浏览器/网页：直接访问 `/notes/:id` 页面，服务端会注入签名 URL
- App / 低代码平台：当前没有独立的"换取签名 URL"接口，建议直接调用 `GET /api/notes/:id` 时由服务端在 `note.audioPath` 里返回带签名的 URL（如有需要可加专属接口，联系管理员）

七牛云私有 bucket 签名有效期默认 1 小时，笔记详情页用 24 小时。

---

## 12. 低代码平台对接示例

以 eazo.ai 类低代码平台为例：

### 12.1 全局配置

1. **Base URL**: `https://shutong.3198.net/api`
2. **认证方式**: Bearer Token
3. **Token 来源**: 用户登录后存到本地存储，每个请求从存储读取注入 `Authorization` 头

### 12.2 登录流程

```
1. 用户在 app 输入邮箱密码
2. POST /api/auth/login { email, password }
3. 拿到 response.token 存到本地存储 localStorage.setItem('sht_token', token)
4. 后续所有请求 header 加：Authorization: Bearer ${localStorage.getItem('sht_token')}
```

### 12.3 首页"当前课程"卡片

```
1. 进入首页 → GET /api/schedule/current
2. 如果 current 非空 → 显示"正在上：数学（已上 12 分钟）"+ "开始录音"按钮
3. 如果 next 非空 → 显示"下一节：物理（15 分钟后开始）"
4. 都为空 → "今天没课了"
```

### 12.4 开始录音流程

```
1. 拿到 current.id (scheduleSlotId)
2. POST /api/notes { "scheduleSlotId": "..." } → 拿到 noteId
3. 启动浏览器录音 (MediaRecorder)
4. 每 60 秒切一段 → POST /api/notes/:noteId/chunk (FormData: audio + transcript + chunk)
5. 用户停止 → 上传最后一段 → POST /api/notes/:noteId/stop-recording
6. 跳转到 /api/notes/:id 轮询 status，等 ready 后展示
```

### 12.5 笔记列表

```
GET /api/notes?page=1
渲染列表，点条目跳详情页 → GET /api/notes/:id
```

### 12.6 课表编辑

```
1. GET /api/courses 拿课程列表
2. GET /api/schedule 拿现有 slots
3. 渲染 7 列 × N 节网格，每格下拉选课程 + 时间 + 教室 + 老师
4. 提交 → PUT /api/schedule { slots: [...] }
```

### 12.7 注意事项

- **Token 过期**: JWT 7 天有效期，过期返回 401 → 引导用户重新登录
- **请求超时**: 上传音频建议设 60s 超时，大文件分段
- **错误处理**: HTTP 4xx 时读 `error` 字段展示给用户
- **CORS**: 浏览器侧请求需服务端加白名单，把你的 app 域名告诉管理员

---

## 13. 接口速查表

| Method | Path | 鉴权 | 用途 |
|---|---|---|---|
| POST | /api/auth/login | ❌ | 邮箱密码登录 |
| POST | /api/auth/wechat/qrcode | ❌ | 微信扫码：取二维码 |
| POST | /api/auth/wechat/verify | ❌ | 微信扫码：验证 |
| POST | /api/auth/logout | ✅ | 登出 |
| GET | /api/auth/me | ✅ | 当前用户 |
| GET | /api/schedule | ✅ | 课表列表 |
| PUT | /api/schedule | ✅ | 保存课表 |
| GET | /api/schedule/current | ✅ | 当前/下一节课 |
| GET | /api/courses | ✅ | 课程列表 |
| GET | /api/courses/:id | ✅ | 课程详情 |
| POST | /api/courses | ✅ | 新建课程 |
| PUT | /api/courses/:id | ✅ | 编辑课程 |
| DELETE | /api/courses/:id | ✅ | 删除课程 |
| GET | /api/notes | ✅ | 笔记列表 |
| GET | /api/notes/:id | ✅ | 笔记详情 |
| POST | /api/notes | ✅ | 新建笔记 |
| POST | /api/notes/:id/chunk | ✅ | 上传录音分块 |
| POST | /api/notes/:id/viewing | ✅ | 标记查看中 |
| POST | /api/notes/:id/stop-recording | ✅ | 停止录音 |
| POST | /api/notes/:id/resume-recording | ✅ | 继续录音 |
| POST | /api/notes/:id/capture | ✅ | 设备拍照 |
| POST | /api/notes/:id/reprocess | ✅ | 重新AI处理 |
| POST | /api/notes/:id/confirm-course | ✅ | 确认建议课程 |
| POST | /api/notes/:id/dismiss-course | ✅ | 忽略建议课程 |
| PUT | /api/notes/:id/course | ✅ | 关联课程 |
| DELETE | /api/notes/:id | ✅ | 删除笔记 |
| POST | /api/upload/audio | ✅ | 独立音频上传 |
| POST | /api/upload/image | ✅ | 独立图片上传 |
| GET | /api/devices | ✅ | 设备列表 |
| POST | /api/devices/bind | ✅ | 绑定设备 |
| DELETE | /api/devices/:id | ✅ | 解绑设备 |
| POST | /api/devices/:id/cmd | ✅ | 发送设备命令 |
| GET | /api/ai/tasks/:noteId | ✅ | AI任务状态 |
| POST | /api/ai/summary/:noteId | ✅ | 触发摘要 |
| POST | /api/ai/exam/:noteId | ✅ | 触发考点 |
| POST | /api/ai/mindmap/:noteId | ✅ | 触发导图 |
| GET | /api/knowledge/search | ✅ | 搜索笔记 |
| POST | /api/knowledge/ask | ✅ | 知识库问答 |
| GET | /api/export/note/:id/pdf | ✅ | 导出PDF(HTML) |
| GET | /api/export/note/:id/docx | ✅ | 导出Word |
