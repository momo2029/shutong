# 服务端商业上线检查清单

## 必须满足

- `docker/.env` 必须设置强随机值：
  - `JWT_SECRET`
  - `MQTT_PASSWORD`
  - `DEVICE_MASTER_KEY`
  - `EMQX_API_PASSWORD`
  - 七牛 `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` / `QINIU_DOMAIN`
- `NODE_ENV=production` 必须生效，服务启动时会校验生产配置。
- EMQX Dashboard 只绑定 `127.0.0.1:18083`，不得直接暴露公网。
- EMQX 通过 HTTP 回调 `/api/mqtt/auth` 认证：
  - 服务端 client id: `sht_server`
  - 服务端 username/password: `MQTT_USER` / `MQTT_PASSWORD`
  - 设备 client id: SN
  - 设备 username: `device:{timestamp}:{signature}`
- 设备生产固件必须设置 `MQTT_MASTER_KEY`，不得依赖固定用户名 `st_device`。
- 七牛必须启用，生产环境不会公开 `/data/*` 本地文件目录。

## 验收命令

```bash
cd server
PATH=/Users/jf/.nvm/versions/node/v22.22.3/bin:$PATH npm run build
PATH=/Users/jf/.nvm/versions/node/v22.22.3/bin:$PATH npm test
```

```bash
cd firmware
source /Users/jf/esp-idf/export.sh
idf.py build
```

## 上线前实测

- 正确设备密钥可连接 MQTT。
- 错误设备密钥会被拒绝。
- 设备只能发布自己的 `sht/{SN}/status`、`audio/chunk`、`image`。
- 设备不能订阅其他 SN 的 `cmd` 或 `ota`。
- 管理员可上传 OTA 固件，普通用户不可访问 OTA API。
- 上传音频、图片、ASR、OCR、LLM 队列可完成一条真实笔记。
- `/health` 返回 `ok`，MQTT、DB、磁盘检查全部通过。
- SQLite 数据目录有自动备份和恢复演练记录。
