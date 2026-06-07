#include "shutong_camera.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sht-cam";

// DFR1154 OV3660 DVP pinout
#define XCLK_GPIO   5
#define SIOD_GPIO   8   // SCCB SDA
#define SIOC_GPIO   9   // SCCB SCL
#define Y9_GPIO     4   // D7
#define Y8_GPIO     6   // D6
#define Y7_GPIO     7   // D5
#define Y6_GPIO     14  // D4
#define Y5_GPIO     17  // D3
#define Y4_GPIO     21  // D2
#define Y3_GPIO     18  // D1
#define Y2_GPIO     16  // D0
#define VSYNC_GPIO  1
#define HREF_GPIO   2
#define PCLK_GPIO   15

void shutong_camera_init(void) {
  camera_config_t cfg = {
    .pin_pwdn = -1,
    .pin_reset = -1,
    .pin_xclk = XCLK_GPIO,
    .pin_sccb_sda = SIOD_GPIO,
    .pin_sccb_scl = SIOC_GPIO,
    .pin_d7 = Y9_GPIO,   .pin_d6 = Y8_GPIO,
    .pin_d5 = Y7_GPIO,   .pin_d4 = Y6_GPIO,
    .pin_d3 = Y5_GPIO,   .pin_d2 = Y4_GPIO,
    .pin_d1 = Y3_GPIO,   .pin_d0 = Y2_GPIO,
    .pin_vsync = VSYNC_GPIO,
    .pin_href = HREF_GPIO,
    .pin_pclk = PCLK_GPIO,
    .xclk_freq_hz = 20000000,
    .ledc_timer = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,
    .frame_size = FRAMESIZE_SVGA,       // 800x600 — good for blackboard OCR
    .jpeg_quality = 10,                  // high quality
    .fb_count = 2,
    .grab_mode = CAMERA_GRAB_LATEST,     // skip stale frames
    .fb_location = CAMERA_FB_IN_PSRAM,   // PSRAM for large frame buffers (8MB PSRAM needs config)
  };

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Camera init failed: 0x%x", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    ESP_LOGI(TAG, "Sensor PID=0x%x", s->id.PID);
    if (s->id.PID == OV3660_PID) {
      s->set_vflip(s, 1);
      s->set_brightness(s, 1);
      s->set_saturation(s, -2);
    }
    // Exposure tuning for classroom blackboard:
    // Blackboard tends to overexpose → lower compensation
    s->set_ae_level(s, -2);         // -2 EV
    s->set_awb_gain(s, 1);          // keep auto white balance
  }
  ESP_LOGI(TAG, "Camera init OK (OV3660 UXGA)");
}

camera_fb_t *shutong_camera_capture(void) {
  return esp_camera_fb_get();
}

void shutong_camera_return(camera_fb_t *fb) {
  if (fb) esp_camera_fb_return(fb);
}
