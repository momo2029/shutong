# 书童 MQTT 通信协议 v1.0

## Broker 连接信息
- 地址: mqtt://shutong.3198.net:1883
- WebSocket: ws://shutong.3198.net:8083/mqtt
- QoS: 1 (至少一次送达)
- ClientID: `sht_<SN>` (设备)，`sht_svr` (服务端)

## Topic 列表

| Topic | 方向 | QoS | 说明 |
|---|---|---|---|
| `sht/{sn}/status` | 设备→服务端 | 1 | 上线/离线/心跳/状态 |
| `sht/{sn}/audio/chunk` | 设备→服务端 | 1 | 音频分段上传 |
| `sht/{sn}/image` | 设备→服务端 | 1 | 拍照图片上传 |
| `sht/{sn}/cmd` | 服务端→设备 | 1 | 远程控制指令 |
| `sht/{sn}/cmd/ack` | 设备→服务端 | 1 | 指令应答 |
| `sht/{sn}/ota` | 服务端→设备 | 1 | OTA推送通知 |

## 通用消息格式

```json
{
  "msg_id": "<uuid>",
  "ts": 1717500000,
  "type": "<message_type>",
  "payload": { }
}
```

## 消息类型定义

### 1. 设备状态 (status)
设备上报，心跳间隔 30s。
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "status",
  "payload": {
    "status": "online",
    "fw_ver": "1.0.0",
    "battery": 85,
    "wifi_rssi": -45
  }
}
```

### 2. 音频分段 (audio_chunk)
每段最长 10 秒，Opus 编码，Base64 传输。
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "audio_chunk",
  "payload": {
    "note_id": "<uuid>",
    "seq": 0,
    "total": 15,
    "codec": "opus",
    "sample_rate": 16000,
    "data": "<base64_encoded_opus>"
  }
}
```
- `seq`: 分段序号，从 0 开始
- `total`: 总分段数（录音开始时预估算，最终可调整）
- 当服务端收到 `seq == total-1` 的包时，表示传输完成，开始合并+ASR
- 服务端按 `note_id` 分组，按 `seq` 排序拼接

### 3. 图片上传 (image)
仅旗舰版设备发送。
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "image",
  "payload": {
    "note_id": "<uuid>",
    "format": "jpeg",
    "width": 800,
    "height": 600,
    "quality": 70,
    "data": "<base64_encoded_jpeg>"
  }
}
```

### 4. 远程控制命令 (cmd)
服务端→设备：
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "cmd",
  "payload": {
    "cmd": "start_record",
    "params": {}
  }
}
```

设备→服务端应答：
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "cmd_ack",
  "payload": {
    "ref_msg_id": "<原命令msg_id>",
    "result": "ok",
    "error": ""
  }
}
```

支持的命令：
- `start_record` — 开始录音
- `stop_record` — 停止录音
- `ping` — 立即上报状态
- `reboot` — 重启设备

### 5. OTA推送 (ota)
```json
{
  "msg_id": "xxx",
  "ts": 1717500000,
  "type": "ota",
  "payload": {
    "version": "1.0.1",
    "url": "https://shutong.3198.net/api/ota/download/standard_1.0.1.bin",
    "size": 1048576,
    "sha256": "<sha256_hash>"
  }
}
```

## 错误处理
- 设备离线时，服务端缓存在线命令最多 5 分钟
- 音频段丢失：设备端超时 5s 未收到 ACK 则重传
- 图片上传失败：设备端最多重试 3 次

## 安全
- 设备首次绑定后，服务端下发 device_token，后续消息带 token 校验
- MQTT Broker 开启 ACL，设备只能发布自己的 topic
