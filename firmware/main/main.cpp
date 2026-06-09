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
#include "mbedtls/base64.h"
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
static int  s_note_elapsed = 0;     // 当前笔记已录秒数（达到10分钟自动切割）

// 笔记切割策略：
// - 静音 10 秒 → 结束当前笔记
// - 连续录音 1 小时 → 自动切割新笔记
#define NOTE_MAX_DURATION (60 * 60)  // 1小时自动切割

// 内部缓冲区
#define AUDIO_CHUNK_SAMPLES (16000 / 2) // 0.5秒每块
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
  s_note_elapsed = 0;
  s_recording = true;
  s_capturing = true;
  ESP_LOGI(TAG, "Recording START: %s", s_note_id);
  set_led(LED_SOLID);
}

// 发送 EOS 标记结束当前笔记
static void send_eos(void) {
  if (!s_recording) return;
  char eos_json[256];
  snprintf(eos_json, sizeof(eos_json),
    "{\"type\":\"audio_eos\",\"payload\":{\"note_id\":\"%s\",\"total\":%d,\"eos\":true}}",
    s_note_id, s_chunk_seq);
  shutong_mqtt_publish("audio/chunk", eos_json);
  ESP_LOGI(TAG, "EOS sent: %s, chunks=%d", s_note_id, s_chunk_seq);
}

// ─── 结束当前录音 ────────────────────────────────────────
static void stop_recording(void) {
  if (!s_recording) return;
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
  // 使用新 API 手动构建 JSON（避免 cJSON 大负载问题）
  char *str = shutong_build_audio_json(s_note_id, s_chunk_seq, total,
                                        (const uint8_t *)buf, samples * 2);
  if (!str) return;
  shutong_mqtt_publish("audio/chunk", str);
  free(str);
  s_chunk_seq++;
}

// ─── photo（JPEG）发送 ──────────────────────────────────
static void send_photo(const uint8_t *jpeg, size_t len) {
  char *str = shutong_build_image_json(s_note_id, jpeg, len);
  if (!str) return;
  shutong_mqtt_publish("image", str);
  free(str);
  ESP_LOGI(TAG, "Photo uploaded: %u bytes", (unsigned)len);
}

// ═══════════════════════════════════════════════════════════
//  任务1：录音任务（VAD 自动录音 + 10分钟自动切割）
// ═══════════════════════════════════════════════════════════
static void record_task(void *arg) {
  while (1) {
    if (!s_auto_record || !shutong_mqtt_is_connected()) {
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    int read = shutong_audio_read(s_record_buf, AUDIO_CHUNK_SAMPLES);
    if (read <= 0) continue;

    bool has_voice = shutong_audio_has_voice(s_record_buf, read);

    if (has_voice) {
      // ── 有人声 ──
      if (!s_recording) {
        start_recording();
        send_audio_chunk(s_record_buf, read, 0, false);
      } else {
        send_audio_chunk(s_record_buf, read, 0, false);
      }
      s_silence_secs = 0;
      s_note_elapsed++;
      set_led(LED_SOLID);

      // 时间切割：连续录音达到 10 分钟 → 自动切笔记
      if (s_note_elapsed >= NOTE_MAX_DURATION) {
        ESP_LOGI(TAG, "Note auto-rotated at %ds", s_note_elapsed);
        send_eos();
        stop_recording();
        vTaskDelay(pdMS_TO_TICKS(500));
        start_recording();
      }

    } else {
      // ── 无人声 ──
      if (s_recording) {
        s_silence_secs++;
        s_note_elapsed++;
        send_audio_chunk(s_record_buf, read, 0, false);

        bool time_up = (s_note_elapsed >= NOTE_MAX_DURATION);
        bool silence_timeout = (s_silence_secs >= 20);
        if (silence_timeout || time_up) {
          send_eos();
          stop_recording();
          if (time_up && s_auto_record) {
            ESP_LOGI(TAG, "Note auto-rotated at %ds", s_note_elapsed);
            vTaskDelay(pdMS_TO_TICKS(500));
            start_recording();
          }
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
    // 开启红外补光，提升暗光画质
    gpio_set_level(IR_LED_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(50)); // 等待 LED 稳定

    camera_fb_t *fb = shutong_camera_capture();

    // 关补光
    gpio_set_level(IR_LED_GPIO, 0);

    if (!fb) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    // ── 帧差检测 ──
    bool changed = shutong_detect_frame_diff(fb->buf, fb->len);

    if (!changed) {
      shutong_camera_return(fb);
      vTaskDelay(pdMS_TO_TICKS(2500));
      continue;
    }

    // ── 人脸检测（当前始终返回 true） ──
    bool has_face = shutong_detect_has_face(fb->buf, fb->len);
    if (!has_face) {
      ESP_LOGD(TAG, "Frame changed but no face, skipping upload");
      shutong_camera_return(fb);
      vTaskDelay(pdMS_TO_TICKS(2500));
      continue;
    }

    // ── 变化 + 含人脸 → MQTT 上传 ──
    send_photo(fb->buf, fb->len);

    // 本地 SD 存储（保留一份）
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
    cJSON *json = cJSON_Parse(payload_json);
    if (!json) return;

    char ref[64] = {0};
    device_cmd_t cmd = proto_parse_cmd(json, ref, sizeof(ref));

    switch (cmd) {
      case CMD_START_RECORD:
        ESP_LOGI(TAG, "CMD: start_record");
        s_auto_record = true;
        break;

      case CMD_STOP_RECORD:
        ESP_LOGI(TAG, "CMD: stop_record");
        s_auto_record = false;
        if (s_recording) {
          send_eos();
          stop_recording();
        }
        break;

      case CMD_PING:
        ESP_LOGI(TAG, "CMD: ping");
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

      case CMD_CAPTURE:
        ESP_LOGI(TAG, "CMD: capture");
#ifdef CONFIG_SHUTONG_FLAGSHIP
        {
          // 如果没在录音，先生成一个临时 note_id
          if (!s_recording) {
            generate_note_id(); // 写入 s_note_id
          }
          // 开启红外补光
          gpio_set_level(IR_LED_GPIO, 1);
          vTaskDelay(pdMS_TO_TICKS(100));
          camera_fb_t *fb = shutong_camera_capture();
          gpio_set_level(IR_LED_GPIO, 0);
          if (fb) {
            send_photo(fb->buf, fb->len);
            shutong_camera_return(fb);
            // 如果临时生成的，删除 SD 上残留的录音目录
            if (s_note_id[0] && shutong_sdcard_mounted()) {
              char dir[96];
              snprintf(dir, sizeof(dir), SD_MOUNT_POINT "/rec/%s", s_note_id);
              // 等几秒让照片存完
            }
          }
          // 发 ACK
          cJSON *ack = proto_build_cmd_ack(ref, "captured", NULL);
          char *str = cJSON_PrintUnformatted(ack);
          shutong_mqtt_publish("cmd/ack", str);
          cJSON_free(str);
          cJSON_Delete(ack);
        }
#endif
        break;

      case CMD_TTS_PLAY:
        ESP_LOGI(TAG, "CMD: tts_play");
        {
          cJSON *payload = cJSON_GetObjectItem(json, "payload");
          cJSON *params = payload ? cJSON_GetObjectItem(payload, "params") : NULL;
          cJSON *data = params ? cJSON_GetObjectItem(params, "data") : NULL;
          if (data && cJSON_IsString(data) && data->valuestring) {
            size_t b64_len = strlen(data->valuestring);
            size_t pcm_cap = (b64_len * 3) / 4 + 4;
            uint8_t *pcm = (uint8_t *)malloc(pcm_cap);
            size_t pcm_len = 0;
            if (pcm && mbedtls_base64_decode(pcm, pcm_cap, &pcm_len, (const unsigned char *)data->valuestring, b64_len) == 0) {
              shutong_speaker_play_pcm(pcm, pcm_len);
              cJSON *ack = proto_build_cmd_ack(ref, "tts_played", NULL);
              char *str = cJSON_PrintUnformatted(ack);
              shutong_mqtt_publish("cmd/ack", str);
              cJSON_free(str);
              cJSON_Delete(ack);
            }
            free(pcm);
          }
        }
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

  // 提前分配 base64 缓冲区（此时堆最干净）
  shutong_proto_init();

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
  gpio_reset_pin(IR_LED_GPIO);
  gpio_set_direction(IR_LED_GPIO, GPIO_MODE_OUTPUT);
  gpio_set_level(IR_LED_GPIO, 0);
  gpio_reset_pin(BOOT_BUTTON_GPIO);
  gpio_set_direction(BOOT_BUTTON_GPIO, GPIO_MODE_INPUT);
  gpio_set_pull_mode(BOOT_BUTTON_GPIO, GPIO_PULLUP_ONLY);

  // 音频
  shutong_audio_init();
  shutong_speaker_init();

  // 录音缓冲区 — 用内部 DRAM 避免 PSRAM 缓存一致性问题
  s_record_buf = (int16_t *)calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t));

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
    } else {
      ESP_LOGI(TAG, "Auto-record OFF (button)");
      if (s_recording) {
        send_eos();
        stop_recording();
      }
      set_led(LED_OFF);
    }
  });

  // 相机（旗舰版）
#ifdef CONFIG_SHUTONG_FLAGSHIP
  shutong_camera_init();
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, FRAMESIZE_VGA);
    s->set_quality(s, 15);
    ESP_LOGI(TAG, "Camera set to VGA quality=15");
  }
#endif

  // WiFi
  auto &ssid_mgr = SsidManager::GetInstance();
  auto &station = WifiStation::GetInstance();
  auto &ap = WifiConfigurationAp::GetInstance();

  while (true) {
    auto ssid_list = ssid_mgr.GetSsidList();
    if (!ssid_list.empty()) {
      station.Start();
      if (station.WaitForConnected(15000)) {
        ESP_LOGI(TAG, "WiFi connected: %s", station.GetSsid().c_str());
        break;
      }
      ESP_LOGW(TAG, "Saved WiFi failed, opening AP for 60s...");
      station.Stop();
    } else {
      ESP_LOGW(TAG, "No saved WiFi, opening AP for 60s...");
    }

    ap.SetSsidPrefix("shutong");
    ap.Start();
    ESP_LOGI(TAG, "AP mode: SSID=%s, URL=%s", ap.GetSsid().c_str(), ap.GetWebServerUrl().c_str());
    vTaskDelay(pdMS_TO_TICKS(60000));
    ap.Stop();
  }

  // MQTT 初始化
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

  ESP_LOGI(TAG, "Online — auto-record=%s (1h auto-rotate)", s_auto_record ? "ON (VAD)" : "OFF");
  if (s_auto_record) set_led(LED_SLOW_BLINK);

  while (1) {
    if (s_recording) {
      set_led(LED_SOLID);
    } else if (s_auto_record) {
      static int blink_tick = 0;
      blink_tick++;
      if (blink_tick >= 20) {
        set_led(LED_SLOW_BLINK);
        blink_tick = 0;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}
