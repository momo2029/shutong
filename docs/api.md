# 书童 API 接口文档

Base URL: `https://shutong.3198.net/api`

## 鉴权

除 `/api/auth/login` 和 `/api/auth/register` 外，所有 API 需要携带 JWT token（httpOnly cookie: `token`）。

## 接口列表

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/register | No | 注册 ({email, password, nickname}) |
| POST | /api/auth/login | No | 登录 ({email, password}) |
| POST | /api/auth/logout | Yes | 登出 |
| GET | /api/auth/me | Yes | 当前用户信息 |

### Devices
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/devices | Yes | 设备列表 |
| POST | /api/devices/bind | Yes | 绑定设备 ({sn, name}) |
| DELETE | /api/devices/:id | Yes | 解绑设备 |
| POST | /api/devices/:id/cmd | Yes | 发送指令 ({cmd, params}) |

### Courses
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/courses | Yes | 课程列表 |
| POST | /api/courses | Yes | 新建 ({name, semester, description}) |
| PUT | /api/courses/:id | Yes | 编辑 |
| DELETE | /api/courses/:id | Yes | 删除 |

### Notes
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/notes | Yes | 列表 (?course=&status=&q=&page=) |
| GET | /api/notes/:id | Yes | 详情 |
| POST | /api/notes | Yes | 新建 |
| DELETE | /api/notes/:id | Yes | 删除 |
| POST | /api/notes/:id/reprocess | Yes | 重新AI处理 |

### Upload
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/upload/audio | Yes | multipart, field: audio |
| POST | /api/upload/image | Yes | multipart, field: image |

### AI
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/ai/tasks/:noteId | Yes | 任务状态 |
| POST | /api/ai/summary/:noteId | Yes | 触发摘要 |
| POST | /api/ai/exam/:noteId | Yes | 触发考点 |
| POST | /api/ai/mindmap/:noteId | Yes | 触发导图 |

### Knowledge
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/knowledge/search | Yes | 搜索 (?q=keyword) |
| POST | /api/knowledge/ask | Yes | 问答 ({question}) |

### Export
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/export/note/:id/pdf | Yes | 导出PDF |
| GET | /api/export/note/:id/docx | Yes | 导出Word |

### Admin
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /api/admin/stats | Admin | 统计 |
| GET | /api/admin/users | Admin | 用户列表 |
| PUT | /api/admin/users/:id | Admin | 修改套餐 |
| POST | /api/admin/firmware | Admin | 上传固件 |
| GET | /api/admin/firmware | Admin | 固件列表 |
