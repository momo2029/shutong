#pragma once
#include <stdint.h>

/**
 * 书童 BLE 广播 — 接收服务器推送的短链并广播
 *
 * 设备不自行生成 URL，等服务器通过 MQTT 推送。
 * 用法：
 *   shutong_ble_init();
 *   // 收到 MQTT ble_url 后调用:
 *   shutong_ble_set_url("https://hq8.net/ab");
 */

// 启动 BLE 广播模块
void shutong_ble_init(void);

// 设置并广播短链 URL
void shutong_ble_set_url(const char *url);

// 停止广播
void shutong_ble_stop(void);

// 是否正在广播
int shutong_ble_is_advertising(void);
