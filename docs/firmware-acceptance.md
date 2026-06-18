# 书童固件提测与发布验收清单

本文档用于实机验证固件是否达到稳定提测和产品发布条件。当前重点是 WiFi 配网、MQTT 上线和 OTA 闭环。

## 稳定提测准入

提测前必须满足：

- 固件构建通过：`source /Users/jf/esp-idf/export.sh && idf.py build`
- 服务端构建通过：`PATH=/Users/jf/.nvm/versions/node/v22.22.3/bin:$PATH npm run build`
- 设备无保存 WiFi 时自动进入配网 AP，SSID 格式为 `shutong-XXXX`
- 手机连接 AP 后，`http://192.168.4.1` 能打开配网页面
- 点击扫描后，AP 列表能稳定返回，不应长时间空白
- 输入正确 WiFi 后，页面显示成功，设备退出 AP 并切换到 STA
- 配网成功判定以拿到 IP 为准，不应只因关联 AP 就返回成功
- 输入错误密码时，页面返回失败，AP 仍保持可访问，可重新提交
- 已保存 WiFi 不可用时，设备尝试连接失败后进入 AP 配网
- MQTT 连接成功后，服务端能收到 `status` 心跳并更新设备在线状态
- OTA 命令能被设备识别，并返回 `ota_started` 或 `ota_failed` ACK

## 产品发布门槛

发布前必须在目标硬件上完成以下场景，并保留串口日志或服务端日志：

1. 首次配网
   - 清空 NVS 或使用新设备启动。
   - 连接 `shutong-XXXX` AP。
   - 页面扫描、选择 SSID、输入密码、提交。
   - 验证设备拿到 IP、退出 AP、MQTT 上线。

2. 错误密码恢复
   - 输入错误密码提交。
   - 页面必须提示失败。
   - AP 不能消失，设备不能重启或卡死。
   - 重新输入正确密码后能成功联网。

3. 已保存 WiFi 重启
   - 设备断电重启。
   - 不进入 AP，自动连接已保存 WiFi。
   - 30 秒内上报 `status` 心跳。

4. WiFi 不可用回退
   - 关闭路由器或移动到不可达环境。
   - 设备连接失败后进入 AP 配网。
   - 恢复或重新配置 WiFi 后能上线。

5. MQTT 命令
   - `ping` 返回 `pong`。
   - `start_record` / `stop_record` 能切换录音状态。
   - `capture` 在旗舰版能上传图片并 ACK。
   - `reboot` 能重启设备。

6. OTA 升级
   - 上传新固件到 `/api/ota/upload`。
   - 从设备详情页下发 `ota` 命令。
   - 设备收到 `payload.params.url/version` 并开始下载。
   - 升级成功后重启，心跳中的 `fw_ver` 更新。
   - 下载失败或 URL 不可达时返回 `ota_failed`，设备不应损坏当前固件。

7. 长时间运行
   - 连续运行至少 4 小时。
   - WiFi 不应频繁掉线。
   - MQTT 断线后应自动重连。
   - 录音、拍照和心跳任务不能导致重启。

## 当前已修复的提测阻断点

- 配网页面 `/scan` 等待扫描完成后返回，减少 AP 列表空白。
- 配网提交等待 `IP_EVENT_STA_GOT_IP`，避免只关联 AP 就误报成功。
- OTA 命令兼容服务端 `payload.params.url/version` 结构。
- OTA URL 缓冲区从 256 字节扩到 512 字节。
- 本地存储模式下固件下载 URL 指向 `/data/files/firmware/...`。

## 仍需实机确认

- 不同路由器下的 APSTA 信道切换稳定性。
- iOS / Android captive portal 页面是否都能打开并提交。
- 七牛私有下载 URL 在设备端是否能被 `esp_https_ota` 正常访问。
- HTTPS 证书校验策略是否符合最终生产安全要求。
- OTA 中途断电后的回滚表现。
