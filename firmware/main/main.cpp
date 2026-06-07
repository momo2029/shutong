#include <stdio.h>
#include <string.h>
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
}
#include "shutong_board.h"

static const char *TAG = "sht-main";

// Recording state
static bool s_recording = false;
static char s_note_id[37];
static int  s_chunk_seq = 0;
static int  s_chunk_total = 0;

static device_info_t s_dev_info = {
  .sn = CONFIG_SHUTONG_SN,
  .fw_ver = "1.0.0",
  .battery = 100,
  .wifi_rssi = 0,
};

// Button (xiaozhi's wrapper, uses espressif__button internally)
static Button s_button(BOOT_BUTTON_GPIO);

// ─── Sound effects ─────────────────────────────────────────
static void play_beep(int freq, int dur, int count) {
  // We just use GPIO LED as visual feedback since speaker is complex to share
  for (int c = 0; c < count; c++) {
    gpio_set_level(BUILTIN_LED_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(dur));
    gpio_set_level(BUILTIN_LED_GPIO, 0);
    if (c < count - 1) vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ─── Audio upload ───────────────────────────────────────────
#define AUDIO_CHUNK_SAMPLES (16000 * 2) // 2 seconds per chunk

static int16_t *s_record_buf = NULL;

static void send_audio_chunk(const int16_t *buf, int samples) {
  cJSON *json = proto_build_audio_chunk(s_note_id, s_chunk_seq, s_chunk_total,
                                         (const uint8_t *)buf, samples * 2);
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("audio/chunk", str);
  cJSON_free(str);
  cJSON_Delete(json);
}

static void record_task(void *arg) {
  while (1) {
    if (!s_recording || !shutong_mqtt_is_connected()) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    gpio_set_level(BUILTIN_LED_GPIO, 1);
    int read = shutong_audio_read(s_record_buf, AUDIO_CHUNK_SAMPLES);
    if (read > 0) {
      send_audio_chunk(s_record_buf, read);
      s_chunk_seq++;
      if (s_chunk_seq >= s_chunk_total) s_chunk_total += 10;
    }
  }
}

// ─── Camera capture (flagship only) ─────────────────────────
static void capture_task(void *arg) {
  int frame_seq = 0;
  while (1) {
    if (s_recording && shutong_sdcard_mounted()) {
#ifdef CONFIG_SHUTONG_FLAGSHIP
      camera_fb_t *fb = shutong_camera_capture();
      if (fb) {
        char path[128];
        char dir[96];
        snprintf(dir, sizeof(dir), SD_MOUNT_POINT "/rec/%s", s_note_id);
        mkdir(dir, 0777);
        snprintf(path, sizeof(path), SD_MOUNT_POINT "/rec/%s/frame_%d.jpg",
                 s_note_id, frame_seq);
        FILE *f = fopen(path, "wb");
        if (f) {
          fwrite(fb->buf, 1, fb->len, f);
          fclose(f);
          ESP_LOGI(TAG, "Frame %d saved: %s (%u bytes)", frame_seq, path, fb->len);
          frame_seq++;
        }
        shutong_camera_return(fb);
      }
#endif
    }
    vTaskDelay(pdMS_TO_TICKS(5000));
  }
}

// ─── Heartbeat ──────────────────────────────────────────────
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

// ─── MQTT command received ─────────────────────────────────
static void on_mqtt_cmd(const char *type, const char *ref_msg_id) {
  ESP_LOGI(TAG, "MQTT cmd: %s, ref=%s", type, ref_msg_id);
}

// ─── Provisioning handler when AP mode is active ─────────────
// Called from provisioning HTTP server. WifiConfigurationAp
// runs its own web server, so we only need to wait.

// ─── Main entry ─────────────────────────────────────────────
extern "C" void app_main(void) {
  ESP_LOGI(TAG, "书童 旗舰版 v%s SN=%s", s_dev_info.fw_ver, CONFIG_SHUTONG_SN);

  // Init NVS
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }

  // Init GPIO
  gpio_reset_pin(BUILTIN_LED_GPIO);
  gpio_set_direction(BUILTIN_LED_GPIO, GPIO_MODE_OUTPUT);
  gpio_reset_pin(BOOT_BUTTON_GPIO);
  gpio_set_direction(BOOT_BUTTON_GPIO, GPIO_MODE_INPUT);
  gpio_set_pull_mode(BOOT_BUTTON_GPIO, GPIO_PULLUP_ONLY);

  // Init audio (PDM mic + I2S speaker)
  shutong_audio_init();
  shutong_speaker_init();

  // Allocate recording buffer
  s_record_buf = (int16_t *)heap_caps_calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t),
                                               MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!s_record_buf) s_record_buf = (int16_t *)calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t));

  // SD card (non-fatal)
  shutong_sdcard_init();

  // Button setup
  s_button.OnClick([]() {
    s_recording = !s_recording;
    if (s_recording) {
      snprintf(s_note_id, sizeof(s_note_id), "%lx-%04x",
               (unsigned long)esp_log_timestamp(),
               (unsigned)(esp_random() & 0xFFFF));
      s_chunk_seq = 0;
      s_chunk_total = 10;
      gpio_set_level(BUILTIN_LED_GPIO, 1);
      ESP_LOGI(TAG, "Recording started: %s", s_note_id);
    } else {
      gpio_set_level(BUILTIN_LED_GPIO, 0);
      ESP_LOGI(TAG, "Recording stopped");
    }
  });

  // Camera (flagship only)
#ifdef CONFIG_SHUTONG_FLAGSHIP
  shutong_camera_init();
#endif

  // Try WiFi station mode first
  auto &station = WifiStation::GetInstance();
  station.Start();
  if (station.WaitForConnected(15000)) {
    ESP_LOGI(TAG, "WiFi connected: %s", station.GetSsid().c_str());
  } else {
    ESP_LOGW(TAG, "No saved WiFi, starting AP mode...");
    station.Stop();

    auto &ap = WifiConfigurationAp::GetInstance();
    ap.SetSsidPrefix("shutong");
    ap.Start();

    ESP_LOGI(TAG, "AP mode: SSID=%s, URL=%s. Connect and configure WiFi.",
             ap.GetSsid().c_str(), ap.GetWebServerUrl().c_str());
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
  }

  // WiFi connected — start MQTT + recording tasks
  shutong_mqtt_init(CONFIG_SHUTONG_SN, CONFIG_MQTT_BROKER_URL, on_mqtt_cmd);

  xTaskCreate(heartbeat_task, "hb", 2048, NULL, 1, NULL);
  xTaskCreate(record_task, "record", 16384, NULL, 5, NULL);
  xTaskCreate(capture_task, "capture", 8192, NULL, 2, NULL);

  vTaskDelay(pdMS_TO_TICKS(3000));
  s_dev_info.wifi_rssi = station.GetRssi();
  cJSON *json = proto_build_status(&s_dev_info);
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("status", str);
  cJSON_free(str);
  cJSON_Delete(json);

  ESP_LOGI(TAG, "Online — press BOOT button to start/stop recording");

  while (1) vTaskDelay(pdMS_TO_TICKS(1000));
}
