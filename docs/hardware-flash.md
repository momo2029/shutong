# 书童 硬件烧录指南

## 硬件版本

| 型号 | 芯片 | 摄像头 | 内存 | Flash |
|---|---|---|---|---|
| 标准版 | ESP32-WROOM | 无 | 520KB SRAM | 8MB |
| 旗舰版 | ESP32-S3 | OV2640 | 512KB SRAM + 8MB PSRAM | 16MB |

## 编译

```bash
cd firmware

# 标准版
idf.py set-target esp32
idf.py menuconfig  # 选择 书童硬件配置 → 标准版，设置 SN
idf.py build

# 旗舰版
idf.py set-target esp32s3
idf.py menuconfig  # 选择 书童硬件配置 → 旗舰版，设置 SN
idf.py build
```

## 烧录

```bash
# 标准版
idf.py -p /dev/cu.usbmodem101 flash monitor

# 旗舰版
idf.py -p /dev/cu.usbmodem101 flash monitor
```

## GPIO 引脚

### 共用
| 功能 | GPIO |
|---|---|
| 录音按键 | 0 (BOOT) |
| 状态LED | 2 |
| I2S SCK | 14 |
| I2S WS | 21 |
| I2S SD | 33 |

### 旗舰版额外
| 功能 | GPIO |
|---|---|
| 拍照按键 | 1 |
| XCLK | 15 |
| SIOD(SDA) | 4 |
| SIOC(SCL) | 5 |
| D0-D7 | 11,9,8,10,12,18,17,16 |
| VSYNC | 6 |
| HREF | 7 |
| PCLK | 13 |

## 配网

1. 设备上电，若未连接过 WiFi 则自动进入 AP 模式
2. 手机连接热点 `shutong-Setup`（开放网络）
3. 浏览器访问 `http://192.168.4.1`
4. 选择 WiFi 并输入密码，设备自动连接并重启

## SN 烧录

SN 通过 `menuconfig` → `书童硬件配置 → 设备序列号` 设置，编译时写入固件。
生产批量烧录时使用 `build-SN0001`, `build-SN0002` 等独立构建。
