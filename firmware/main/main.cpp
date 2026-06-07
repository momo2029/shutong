#include <stdio.h>
#include <string.h>
#include <cstdlib>  // abs()
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_random.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "cJSON.h"
#include <sys/stat.h>

// Xiaozhi WiFi + Button
#include <wifi_station.h>
#include <wifi_configuration_ap.h>
#include <ssid_manager.h>
#include "button.h"

// Shutong components (C code, need extern "C" for C++ linking)
extern "C" {
#include "shutong_audio.h"
#include "shutong_speaker.h"
#include "shutong_sdcard.h"
#include "shutong_proto.h"
#include "shutong_mqtt.h"
#include "shutong_camera.h"
#include "shutong_detect.h"
}
#include "shutong_board.h"

static const char *TAG = "sht-main";

// ─── 全局状态 ────────────────────────────────────────────
static bool s_auto_record = true;   // 主开关：开机默认开启
static bool s_recording = false;    // 当前是否有活跃录音
static bool s_capturing = false;    // 当前是否有活跃拍照（有录音才有拍照）
static char s_note_id[37];
static int  s_chunk_seq = 0;
static int  s_silence_secs = 0;     // 连续静音秒数（达到10秒结束录音）

// 内部缓冲区
#define AUDIO_CHUNK_SAMPLES (16000 * 2) // 2秒每块
static int16_t *s_record_buf = NULL;

static device_info_t s_dev_info = {
  .sn = CONFIG_SHUTONG_SN,
  .fw_ver = "1.0.0",
  .battery = 100,
  .wifi_rssi = 0,
};

// Button (xiaozhi's wrapper, uses espressif__button internally)
static Button s_button(BOOT_BUTTON_GPIO);

// ─── LED 指示 ────────────────────────────────────────────
enum led_mode_t {
  LED_OFF = 0,
  LED_SOLID,
  LED_SLOW_BLINK,  // 500ms on/off
  LED_FAST_BLINK,  // 100ms on/off
};
static void set_led(led_mode_t mode) {
  static bool led_on = false;
  switch (mode) {
    case LED_OFF:
      gpio_set_level(BUILTIN_LED_GPIO, 0);
      break;
    case LED_SOLID:
      gpio_set_level(BUILTIN_LED_GPIO, 1);
      break;
    case LED_SLOW_BLINK:
      led_on = !led_on;
      gpio_set_level(BUILTIN_LED_GPIO, led_on ? 1 : 0);
      break;
    case LED_FAST_BLINK:
      led_on = !led_on;
      gpio_set_level(BUILTIN_LED_GPIO, led_on ? 1 : 0);
      break;
  }
}

// ─── 生成 note_id ────────────────────────────────────────
static void generate_note_id(void) {
  snprintf(s_note_id, sizeof(s_note_id), "%lx-%04x",
           (unsigned long)esp_log_timestamp(),
           (unsigned)(esp_random() & 0xFFFF));
}

// ─── 开始新录音 ──────────────────────────────────────────
static void start_recording(void) {
  if (s_recording) return;
  generate_note_id();
  s_chunk_seq = 0;
  s_silence_secs = 0;
  s_recording = true;
  s_capturing = true;
  ESP_LOGI(TAG, "Recording START: %s", s_note_id);
  set_led(LED_SOLID);
}

// ─── 结束当前录音 ────────────────────────────────────────
static void stop_recording(void) {
  if (!s_recording) return;

  // 发送最后一块标记 total（当前 seq 即为总块数）
  // 注：最后一块已在 record_task 的静音逻辑中发送，此处仅收尾
  ESP_LOGI(TAG, "Recording END: %s, chunks=%d", s_note_id, s_chunk_seq);

  s_recording = false;
  s_capturing = false;
  s_silence_secs = 0;

  // LED 回到待机闪烁
  if (s_auto_record) {
    set_led(LED_SLOW_BLINK);
  } else {
    set_led(LED_OFF);
  }
}

// ─── audio chunk 发送 ────────────────────────────────────
static void send_audio_chunk(const int16_t *buf, int samples, int total, bool eos) {
  cJSON *json = proto_build_audio_chunk(s_note_id, s_chunk_seq, total,
                                         (const uint8_t *)buf, samples * 2);
  // 附加 eos 标记
  if (eos) {
    cJSON *p = cJSON_GetObjectItem(json, "payload");
    if (p) cJSON_AddBoolToObject(p, "eos", true);
  }
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("audio/chunk", str);
  cJSON_free(str);
  cJSON_Delete(json);
  s_chunk_seq++;
}

// ─── photo（JPEG）发送 ──────────────────────────────────
static void send_photo(const uint8_t *jpeg, size_t len) {
  cJSON *json = proto_build_image(s_note_id, (uint8_t *)jpeg, len);
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("image", str);
  cJSON_free(str);
  cJSON_Delete(json);
  ESP_LOGI(TAG, "Photo uploaded: %u bytes", (unsigned)len);
}

// ═══════════════════════════════════════════════════════════
//  任务1：录音任务（VAD 自动录音）
// ═══════════════════════════════════════════════════════════
static void record_task(void *arg) {
  while (1) {
    if (!s_auto_record || !shutong_mqtt_is_connected()) {
      // 未开启自动录音或 MQTT 未连接 → 静候
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    // 读取 2 秒音频
    int read = shutong_audio_read(s_record_buf, AUDIO_CHUNK_SAMPLES);
    if (read <= 0) continue;

    // VAD 检测
    bool has_voice = shutong_audio_has_voice(s_record_buf, read);

    if (has_voice) {
      // ── 有人声 ──
      if (!s_recording) {
        // 之前静音，刚检测到人声 → 开始新录音
        start_recording();

        // 发送预卷数据（环形缓冲区中的最近 ~5 秒，包含当前块）
        size_t pre_samples = shutong_audio_buffer_available();
        if (pre_samples > AUDIO_CHUNK_SAMPLES * 3) {
          pre_samples = AUDIO_CHUNK_SAMPLES * 3; // 最多发 3 个预卷块（6秒）
        }

        if (pre_samples > 0) {
          int16_t *pre_buf = (int16_t *)heap_caps_malloc(pre_samples * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
          if (pre_buf) {
            size_t got = shutong_audio_buffer_read(pre_buf, pre_samples);
            int pos = 0;
            while (pos < (int)got) {
              int chunk_sz = (got - pos > AUDIO_CHUNK_SAMPLES) ? AUDIO_CHUNK_SAMPLES : (got - pos);
              send_audio_chunk(pre_buf + pos, chunk_sz, 0, false);
              pos += chunk_sz;
            }
            free(pre_buf);
          }
        }
        // 注意：预卷已包含当前块，不重复发送
      } else {
        // 已在录音中 → 发送当前块
        send_audio_chunk(s_record_buf, read, 0, false);
      }
      s_silence_secs = 0;
      set_led(LED_SOLID);

    } else {
      // ── 无人声 ──
      if (s_recording) {
        s_silence_secs += 2; // 每次读 2 秒
        // 仍然发送静音块，让录音连续
        send_audio_chunk(s_record_buf, read, 0, false);

        if (s_silence_secs >= 10) {
          // 静音超过 10 秒 → 结束录音
          // 发送最后一块带 eos 标记
          // 注：刚才已经发了这个块，单独发一个 eos 标记
          cJSON *json = cJSON_CreateObject();
          cJSON_AddStringToObject(json, "type", "audio_eos");
          cJSON *p = cJSON_CreateObject();
          cJSON_AddStringToObject(p, "note_id", s_note_id);
          cJSON_AddNumberToObject(p, "total", s_chunk_seq);
          cJSON_AddBoolToObject(p, "eos", true);
          cJSON_AddItemToObject(json, "payload", p);
          char *str = cJSON_PrintUnformatted(json);
          shutong_mqtt_publish("audio/chunk", str);
          cJSON_free(str);
          cJSON_Delete(json);

          stop_recording();
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  任务2：拍照任务（帧差 + 人脸检测 → 上传）
// ═══════════════════════════════════════════════════════════
static void capture_task(void *arg) {
  while (1) {
    if (!s_auto_record || !s_capturing || !shutong_mqtt_is_connected()) {
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

#ifdef CONFIG_SHUTONG_FLAGSHIP
    // 拍照
    camera_fb_t *fb = shutong_camera_capture();
    if (!fb) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    // ── 帧差检测 ──
    bool changed = shutong_detect_frame_diff(fb->buf, fb->len);

    if (!changed) {
      // 画面无变化 → 丢弃
      shutong_camera_return(fb);
      vTaskDelay(pdMS_TO_TICKS(2500));
      continue;
    }

    // ── 人脸检测（可选） ──
    bool has_face = shutong_detect_has_face(fb->buf, fb->len);
    if (!has_face) {
      // 无人脸 → 丢弃但记录（可能只翻页了黑板）
      ESP_LOGD(TAG, "Frame changed but no face, skipping upload");
      shutong_camera_return(fb);
      vTaskDelay(pdMS_TO_TICKS(2500));
      continue;
    }

    // ── 变化 + 含人脸 → MQTT 上传 ──
    send_photo(fb->buf, fb->len);

    // 本地 SD 存储（可选，保留一份）
    if (shutong_sdcard_mounted()) {
      char path[128];
      char dir[96];
      snprintf(dir, sizeof(dir), SD_MOUNT_POINT "/rec/%s", s_note_id);
      mkdir(dir, 0777);
      snprintf(path, sizeof(path), SD_MOUNT_POINT "/rec/%s/frame_%d.jpg",
               s_note_id, s_chunk_seq);
      FILE *f = fopen(path, "wb");
      if (f) {
        fwrite(fb->buf, 1, fb->len, f);
        fclose(f);
        ESP_LOGI(TAG, "Photo saved: %s (%u bytes)", path, (unsigned)fb->len);
      }
    }

    shutong_camera_return(fb);
#endif

    vTaskDelay(pdMS_TO_TICKS(2500)); // 2.5 秒间隔
  }
}

// ═══════════════════════════════════════════════════════════
//  任务3：心跳（30秒）
// ═══════════════════════════════════════════════════════════
static void heartbeat_task(void *arg) {
  while (1) {
    vTaskDelay(pdMS_TO_TICKS(30000));
    if (WifiStation::GetInstance().IsConnected() && shutong_mqtt_is_connected()) {
      s_dev_info.wifi_rssi = WifiStation::GetInstance().GetRssi();
      cJSON *json = proto_build_status(&s_dev_info);
      char *str = cJSON_PrintUnformatted(json);
      shutong_mqtt_publish("status", str);
      cJSON_free(str);
      cJSON_Delete(json);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  MQTT 命令处理
// ═══════════════════════════════════════════════════════════
static void on_mqtt_cmd(const char *type, const char *payload_json, const char *ref_msg_id) {
  ESP_LOGI(TAG, "MQTT msg type=%s ref=%s", type, ref_msg_id ? ref_msg_id : "");

  if (strcmp(type, "cmd") == 0 && payload_json) {
    // 解析 payload 中的 cmd 字段
    cJSON *json = cJSON_Parse(payload_json);
    if (!json) return;

    char ref[64] = {0};
    device_cmd_t cmd = proto_parse_cmd(json, ref, sizeof(ref));

    switch (cmd) {
      case CMD_START_RECORD:
        ESP_LOGI(TAG, "CMD: start_record");
        s_auto_record = true;
        if (!s_recording) {
          // 如果有正在录音则不管，VAD 会继续
        }
        break;

      case CMD_STOP_RECORD:
        ESP_LOGI(TAG, "CMD: stop_record");
        s_auto_record = false;
        if (s_recording) {
          stop_recording();
        }
        break;

      case CMD_PING:
        ESP_LOGI(TAG, "CMD: ping");
        // 回复 ACK
        {
          cJSON *ack = proto_build_cmd_ack(ref, "pong", NULL);
          char *str = cJSON_PrintUnformatted(ack);
          shutong_mqtt_publish("cmd/ack", str);
          cJSON_free(str);
          cJSON_Delete(ack);
        }
        break;

      case CMD_REBOOT:
        ESP_LOGI(TAG, "CMD: reboot");
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
        break;

      default:
        ESP_LOGW(TAG, "Unknown cmd");
        break;
    }

    cJSON_Delete(json);
  }
}

// ─── 主入口 ─────────────────────────────────────────────
extern "C" void app_main(void) {
  ESP_LOGI(TAG, "书童 旗舰版 v%s SN=%s 自动录音模式", s_dev_info.fw_ver, CONFIG_SHUTONG_SN);

  // Init NVS
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }

  ESP_ERROR_CHECK(esp_event_loop_create_default());

  // GPIO
  gpio_reset_pin(BUILTIN_LED_GPIO);
  gpio_set_direction(BUILTIN_LED_GPIO, GPIO_MODE_OUTPUT);
  gpio_reset_pin(BOOT_BUTTON_GPIO);
  gpio_set_direction(BOOT_BUTTON_GPIO, GPIO_MODE_INPUT);
  gpio_set_pull_mode(BOOT_BUTTON_GPIO, GPIO_PULLUP_ONLY);

  // 音频
  shutong_audio_init();
  shutong_speaker_init();

  // 录音缓冲区
  s_record_buf = (int16_t *)heap_caps_calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t),
                                               MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!s_record_buf) s_record_buf = (int16_t *)calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t));

  // SD 卡
  shutong_sdcard_init();

  // 检测模块（帧差 + 人脸）
  shutong_detect_init();

  // 按钮
  s_button.OnClick([]() {
    s_auto_record = !s_auto_record;
    if (s_auto_record) {
      ESP_LOGI(TAG, "Auto-record ON (button)");
      set_led(LED_SLOW_BLINK);
      // 如果正在录音则不重置
    } else {
      ESP_LOGI(TAG, "Auto-record OFF (button)");
      if (s_recording) stop_recording();
      set_led(LED_OFF);
    }
  });

  // 相机（旗舰版）
#ifdef CONFIG_SHUTONG_FLAGSHIP
  shutong_camera_init();
  // 设置为 VGA 以减少数据量，教室黑板足够
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, FRAMESIZE_VGA);
    s->set_quality(s, 15);
    ESP_LOGI(TAG, "Camera set to VGA quality=15");
  }
#endif

  // WiFi
  auto &ssid_mgr = SsidManager::GetInstance();
  auto ssid_list = ssid_mgr.GetSsidList();
  auto &station = WifiStation::GetInstance();

  if (!ssid_list.empty()) {
    station.Start();
    if (station.WaitForConnected(15000)) {
      ESP_LOGI(TAG, "WiFi connected: %s", station.GetSsid().c_str());
    } else {
      ESP_LOGW(TAG, "Saved WiFi failed, starting AP mode...");
      station.Stop();
      auto &ap = WifiConfigurationAp::GetInstance();
      ap.SetSsidPrefix("shutong");
      ap.Start();
      ESP_LOGI(TAG, "AP mode: SSID=%s, URL=%s", ap.GetSsid().c_str(), ap.GetWebServerUrl().c_str());
      while (1) vTaskDelay(pdMS_TO_TICKS(1000));
    }
  } else {
    ESP_LOGW(TAG, "No saved WiFi, starting AP mode...");
    auto &ap = WifiConfigurationAp::GetInstance();
    ap.SetSsidPrefix("shutong");
    ap.Start();
    ESP_LOGI(TAG, "AP mode: SSID=%s, URL=%s", ap.GetSsid().c_str(), ap.GetWebServerUrl().c_str());
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
  }

  // MQTT 初始化（使用修改后的 callback 签名传入消息处理）
  shutong_mqtt_init(CONFIG_SHUTONG_SN, CONFIG_MQTT_BROKER_URL, on_mqtt_cmd);

  // 启动任务
  xTaskCreate(heartbeat_task, "hb", 2048, NULL, 1, NULL);
  xTaskCreate(record_task, "record", 16384, NULL, 5, NULL);
  xTaskCreate(capture_task, "capture", 16384, NULL, 2, NULL);

  vTaskDelay(pdMS_TO_TICKS(3000));
  s_dev_info.wifi_rssi = station.GetRssi();
  cJSON *json = proto_build_status(&s_dev_info);
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("status", str);
  cJSON_free(str);
  cJSON_Delete(json);

  ESP_LOGI(TAG, "Online — auto-record=%s", s_auto_record ? "ON (VAD)" : "OFF");
  if (s_auto_record) set_led(LED_SLOW_BLINK);

  while (1) {
    // LED 闪烁管理
    if (s_recording) {
      set_led(LED_SOLID);
    } else if (s_auto_record) {
      // 待机时慢速呼吸（每 2 秒 flip 一次）
      static int blink_tick = 0;
      blink_tick++;
      if (blink_tick >= 20) { // ~2秒
        set_led(LED_SLOW_BLINK);
        blink_tick = 0;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}
