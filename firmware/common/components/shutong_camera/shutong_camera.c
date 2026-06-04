#include "shutong_camera.h"
#include "esp_log.h"

static const char *TAG = "sht-cam";

void shutong_camera_init(void) {
  camera_config_t cfg = {
    .pin_pwdn = -1,
    .pin_reset = -1,
    .pin_xclk = 15,
    .pin_sccb_sda = 4,
    .pin_sccb_scl = 5,
    .pin_d7 = 16, .pin_d6 = 17, .pin_d5 = 18, .pin_d4 = 12,
    .pin_d3 = 10, .pin_d2 = 8,  .pin_d1 = 9,  .pin_d0 = 11,
    .pin_vsync = 6,
    .pin_href = 7,
    .pin_pclk = 13,
    .xclk_freq_hz = 20000000,
    .ledc_timer = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,
    .frame_size = FRAMESIZE_VGA,
    .jpeg_quality = 15,
    .fb_count = 2,
    .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
  };

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Camera init failed: 0x%x", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, 0);
    s->set_hmirror(s, 0);
    s->set_brightness(s, 0);
    s->set_contrast(s, 0);
    s->set_saturation(s, 0);
    s->set_quality(s, 15);
  }
  ESP_LOGI(TAG, "Camera init OK (OV2640, VGA JPEG)");
}

camera_fb_t *shutong_camera_capture(void) {
  return esp_camera_fb_get();
}
