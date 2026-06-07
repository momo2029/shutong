#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "esp_http_server.h"
#include "cJSON.h"

#include "shutong_wifi.h"
#include "shutong_mqtt.h"
#include "shutong_audio.h"
#include "shutong_speaker.h"
#include "shutong_proto.h"

#ifdef CONFIG_SHUTONG_FLAGSHIP
#include "shutong_camera.h"
#endif
#include "shutong_sdcard.h"

static const char *TAG = "sht-main";

// GPIO: button + LED (DFR1154 pinout)
#define BTN_RECORD  GPIO_NUM_0   // Boot button
#define LED_STATUS  GPIO_NUM_3   // Onboard LED (DFR1154)
#define IR_LED      GPIO_NUM_47  // IR LED for night vision
#ifdef CONFIG_SHUTONG_FLAGSHIP
#define BTN_CAMERA  GPIO_NUM_1   // Extra button for photo (flagship)
#endif

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

// ─── LED ───────────────────────────────────────────────────
static void led_init(void) {
  gpio_reset_pin(LED_STATUS);
  gpio_set_direction(LED_STATUS, GPIO_MODE_OUTPUT);
  gpio_set_level(LED_STATUS, 0);
}
static void led_set(int on) { gpio_set_level(LED_STATUS, on); }

// ─── Heartbeat ─────────────────────────────────────────────
static void heartbeat_task(void *arg) {
  while (1) {
    vTaskDelay(pdMS_TO_TICKS(30000));
    if (shutong_wifi_is_connected() && shutong_mqtt_is_connected()) {
      s_dev_info.wifi_rssi = shutong_wifi_rssi();
      cJSON *json = proto_build_status(&s_dev_info);
      char *str = cJSON_PrintUnformatted(json);
      shutong_mqtt_publish("status", str);
      cJSON_free(str);
      cJSON_Delete(json);
    }
  }
}

// ─── Audio upload ───────────────────────────────────────────
#define AUDIO_CHUNK_SAMPLES (16000 * 2) // 2 seconds per chunk (64KB)

static void send_audio_chunk(const int16_t *buf, int samples) {
  cJSON *json = proto_build_audio_chunk(s_note_id, s_chunk_seq, s_chunk_total,
                                         (const uint8_t *)buf, samples * 2);
  char *str = cJSON_PrintUnformatted(json);
  shutong_mqtt_publish("audio/chunk", str);
  cJSON_free(str);
  cJSON_Delete(json);
}

static void record_task(void *arg) {
  int16_t *buf = heap_caps_calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!buf) buf = heap_caps_calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t),
                                    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!buf) buf = calloc(AUDIO_CHUNK_SAMPLES, sizeof(int16_t));
  if (!buf) {
    ESP_LOGE(TAG, "Failed to alloc record buffer");
    vTaskDelete(NULL);
    return;
  }
  while (1) {
    if (!s_recording || !shutong_mqtt_is_connected()) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    led_set(1);
    int read = shutong_audio_read(buf, AUDIO_CHUNK_SAMPLES);
    if (read > 0) {
      send_audio_chunk(buf, read);
      s_chunk_seq++;
      if (s_chunk_seq >= s_chunk_total) {
        s_chunk_total += 10; // Extend estimate
      }
    }
  }
}

// ─── Buttons ────────────────────────────────────────────────
static void button_task(void *arg) {
  vTaskDelay(pdMS_TO_TICKS(2000)); // Ignore boot-time button state
  bool last_btn = gpio_get_level(BTN_RECORD);
#ifdef CONFIG_SHUTONG_FLAGSHIP
  bool last_cam = true;
#endif
  while (1) {
    bool btn = gpio_get_level(BTN_RECORD);
    // Boot button is active low
    if (!btn && last_btn) {
      vTaskDelay(pdMS_TO_TICKS(50));
      if (!gpio_get_level(BTN_RECORD)) {
        s_recording = !s_recording;
        if (s_recording) {
          // Generate note_id: Unix timestamp prefix
          snprintf(s_note_id, sizeof(s_note_id), "%lx-%04x",
                   (unsigned long)esp_log_timestamp(),
                   (unsigned)(esp_random() & 0xFFFF));
          s_chunk_seq = 0;
          s_chunk_total = 10;
          shutong_speaker_play_short_prompt();
          ESP_LOGI(TAG, "Recording started: %s", s_note_id);
        } else {
          shutong_speaker_play_short_prompt();
          vTaskDelay(pdMS_TO_TICKS(200));
          shutong_speaker_play_short_prompt();
          ESP_LOGI(TAG, "Recording stopped");
          led_set(0);
        }
      }
    }
    last_btn = btn;

#ifdef CONFIG_SHUTONG_FLAGSHIP
    bool cam = gpio_get_level(BTN_CAMERA);
    if (!cam && last_cam) {
      vTaskDelay(pdMS_TO_TICKS(50));
      if (!gpio_get_level(BTN_CAMERA)) {
        camera_fb_t *fb = shutong_camera_capture();
        if (fb) {
          cJSON *json = proto_build_image(s_note_id, fb->buf, fb->len);
          char *str = cJSON_PrintUnformatted(json);
          shutong_mqtt_publish("image", str);
          cJSON_free(str);
          cJSON_Delete(json);
          esp_camera_fb_return(fb);
          ESP_LOGI(TAG, "Photo captured");
        }
      }
    }
    last_cam = cam;
#endif

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ─── MQTT command callback ────────────────────────────────
static void on_mqtt_cmd(const char *type, const char *ref_msg_id) {
  if (strcmp(type, "cmd") == 0) {
    // Handled by proto_parse_cmd in the full implementation
    ESP_LOGI(TAG, "Received cmd, ref=%s", ref_msg_id);

    // Send ack
    cJSON *ack = proto_build_cmd_ack(ref_msg_id, "ok", NULL);
    char *str = cJSON_PrintUnformatted(ack);
    shutong_mqtt_publish("cmd/ack", str);
    cJSON_free(str);
    cJSON_Delete(ack);
  } else if (strcmp(type, "ota") == 0) {
    ESP_LOGI(TAG, "OTA notification received");
    // OTA will be processed in main loop
  }
}

// ─── OTA ────────────────────────────────────────────────────
// TODO: Implement OTA download and apply
// static void ota_task(void *arg) {
//   esp_https_ota_config_t ota_config = {
//     .http_config = ESP_HTTP_CLIENT_CONFIG_DEFAULT(),
//   };
//   esp_https_ota(&ota_config);
//   vTaskDelete(NULL);
// }

// ─── HTTP provisioning server ──────────────────────────────
static esp_err_t prov_handler(httpd_req_t *req) {
  const char *resp = "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>书童配网</title><style>body{font-family:sans-serif;background:#1e293b;color:#f8fafc;max-width:400px;margin:40px auto;padding:20px}h2{color:#4f46e5}.card{background:#334155;border-radius:8px;padding:16px;margin:12px 0}input,button{width:100%;padding:10px;margin:4px 0;border-radius:6px;border:none;font-size:14px}button{background:#4f46e5;color:#fff;cursor:pointer}.net{display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid #475569;cursor:pointer}.net:hover{background:#3b4f6b}</style></head><body><h2>书童 配网</h2><div id='nets'></div><div class='card'><input id='ssid' placeholder='WiFi名称'><input id='pass' placeholder='密码' type='password'><button onclick='connect()'>连接</button></div><p id='msg'></p><script>fetch('/scan').then(r=>r.json()).then(d=>{d.forEach(n=>{document.getElementById('nets').innerHTML+='<div class=net onclick=\"document.getElementById(\\'ssid\\').value=\\''+n.ssid+'\\'\">'+n.ssid+' <span>'+(n.rssi+'').slice(0,2)+'</span></div>'})});function connect(){var s=document.getElementById('ssid').value;var p=document.getElementById('pass').value;fetch('/connect',{method:'POST',body:'ssid='+encodeURIComponent(s)+'&pass='+encodeURIComponent(p)}).then(r=>r.text()).then(t=>{document.getElementById('msg').textContent=t})}</script></body></html>";
  httpd_resp_send(req, resp, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

static esp_err_t scan_handler(httpd_req_t *req) {
  wifi_scan_config_t scan_cfg = { .show_hidden = false, .scan_type = WIFI_SCAN_TYPE_ACTIVE };
  esp_wifi_scan_start(&scan_cfg, true);
  uint16_t count = 0;
  esp_wifi_scan_get_ap_num(&count);
  wifi_ap_record_t *aps = calloc(count, sizeof(wifi_ap_record_t));
  esp_wifi_scan_get_ap_records(&count, aps);

  cJSON *arr = cJSON_CreateArray();
  for (int i = 0; i < count; i++) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "ssid", (char *)aps[i].ssid);
    cJSON_AddNumberToObject(o, "rssi", aps[i].rssi);
    cJSON_AddBoolToObject(o, "secure", aps[i].authmode != WIFI_AUTH_OPEN);
    cJSON_AddItemToArray(arr, o);
  }
  free(aps);
  char *js = cJSON_PrintUnformatted(arr);
  httpd_resp_send(req, js, HTTPD_RESP_USE_STRLEN);
  cJSON_free(js);
  cJSON_Delete(arr);
  return ESP_OK;
}

static esp_err_t connect_handler(httpd_req_t *req) {
  char buf[128];
  int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
  if (len <= 0) { httpd_resp_sendstr(req, "ERROR"); return ESP_FAIL; }
  buf[len] = '\0';

  char ssid[33] = {0}, pass[65] = {0};
  char *p = strstr(buf, "ssid=");
  if (p) {
    p += 5;
    int i = 0;
    while (*p && *p != '&' && i < 32) ssid[i++] = *p++;
    ssid[i] = '\0';
  }
  p = strstr(buf, "pass=");
  if (p) {
    p += 5;
    int i = 0;
    while (*p && *p != '&' && i < 64) pass[i++] = *p++;
    pass[i] = '\0';
  }

  shutong_wifi_request_connect(ssid, pass);
  httpd_resp_sendstr(req, "OK - 正在连接，设备即将重启");
  return ESP_OK;
}

static void start_prov_server(void) {
  httpd_handle_t server = NULL;
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.max_uri_handlers = 8;
  httpd_start(&server, &cfg);

  httpd_uri_t root = { .uri = "/", .method = HTTP_GET, .handler = prov_handler, .user_ctx = NULL };
  httpd_uri_t scan = { .uri = "/scan", .method = HTTP_GET, .handler = scan_handler, .user_ctx = NULL };
  httpd_uri_t conn = { .uri = "/connect", .method = HTTP_POST, .handler = connect_handler, .user_ctx = NULL };
  httpd_register_uri_handler(server, &root);
  httpd_register_uri_handler(server, &scan);
  httpd_register_uri_handler(server, &conn);
  ESP_LOGI(TAG, "Provisioning HTTP server started on port 80");
}

// ─── Camera capture ─────────────────────────────────────────
#define CAPTURE_INTERVAL_MS 5000  // 5 seconds between frames

static void capture_task(void *arg) {
  int frame_seq = 0;
  while (1) {
    if (s_recording && shutong_sdcard_mounted()) {
      camera_fb_t *fb = shutong_camera_capture();
      if (fb) {
        // Build path: /sdcard/rec/{note_id}/frame_{seq}.jpg
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

        // Shutter click sound (non-blocking — runs in speaker task context)
        shutong_speaker_play_shutter();
      } else {
        ESP_LOGW(TAG, "Capture failed");
      }
    }
    vTaskDelay(pdMS_TO_TICKS(CAPTURE_INTERVAL_MS));
  }
}

// ─── App entry ──────────────────────────────────────────────
void app_main(void) {
  ESP_LOGI(TAG, "书童 %s v%s SN=%s",
#ifdef CONFIG_SHUTONG_FLAGSHIP
    "旗舰版",
#else
    "标准版",
#endif
    s_dev_info.fw_ver, s_dev_info.sn);

  // GPIO
  led_init();
  gpio_reset_pin(BTN_RECORD);
  gpio_set_direction(BTN_RECORD, GPIO_MODE_INPUT);
  gpio_set_pull_mode(BTN_RECORD, GPIO_PULLUP_ONLY);
#ifdef CONFIG_SHUTONG_FLAGSHIP
  gpio_reset_pin(BTN_CAMERA);
  gpio_set_direction(BTN_CAMERA, GPIO_MODE_INPUT);
  gpio_set_pull_mode(BTN_CAMERA, GPIO_PULLUP_ONLY);
  // IR LED for night vision (off by default)
  gpio_reset_pin(IR_LED);
  gpio_set_direction(IR_LED, GPIO_MODE_OUTPUT);
  gpio_set_level(IR_LED, 0);
#endif

  // Audio
  shutong_audio_init();

  // Speaker & boot sound
  shutong_speaker_init();
  shutong_speaker_play_boot();

  // SD card (non-fatal if absent)
  esp_err_t sd_ret = shutong_sdcard_init();
  if (sd_ret != ESP_OK) {
    ESP_LOGW(TAG, "SD card not available, recording to memory only");
  }

  // WiFi
  shutong_wifi_init();

  // Play status sound based on connection result
  if (shutong_wifi_is_connected()) {
    shutong_speaker_play_wifi_connected();
  } else {
    shutong_speaker_play_ap_mode();
  }

  // Camera (always init if flagship — capture works without WiFi)
#ifdef CONFIG_SHUTONG_FLAGSHIP
  shutong_camera_init();
  shutong_camera_stream_start();
#endif

  // Start capture task (5s periodic frame grab to SD card)
  xTaskCreate(capture_task, "capture", 8192, NULL, 2, NULL);

  if (shutong_wifi_is_connected()) {

    // MQTT
    shutong_mqtt_init(CONFIG_SHUTONG_SN, CONFIG_MQTT_BROKER_URL, on_mqtt_cmd);

    // Tasks
    xTaskCreate(heartbeat_task, "hb", 2048, NULL, 1, NULL);
    xTaskCreate(record_task, "record", 16384, NULL, 5, NULL);
    xTaskCreate(button_task, "btn", 2048, NULL, 3, NULL);

    // Wait for MQTT connection then send online status
    vTaskDelay(pdMS_TO_TICKS(3000));
    s_dev_info.wifi_rssi = shutong_wifi_rssi();
    cJSON *json = proto_build_status(&s_dev_info);
    char *str = cJSON_PrintUnformatted(json);
    shutong_mqtt_publish("status", str);
    cJSON_free(str);
    cJSON_Delete(json);

    ESP_LOGI(TAG, "Online — press BOOT button to start/stop recording");
  } else {
    // AP mode: start provisioning web server
    start_prov_server();
  }

  // Main loop: handle pending WiFi connects
  while (1) {
    shutong_wifi_process_pending();
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}
