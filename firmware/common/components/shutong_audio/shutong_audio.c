#include "shutong_audio.h"
#include "driver/i2s_common.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include <string.h>

static const char *TAG = "sht-audio";
static i2s_chan_handle_t s_rx_chan = NULL;

// Circular buffer: ~5 seconds at 16kHz 16-bit mono = 160,000 bytes
#define AUDIO_BUF_SIZE (16000 * 2 * 5)
static int16_t *s_audio_buf = NULL;
static volatile size_t s_write_pos = 0;

// DC tracking: exponential moving average for DC offset removal
static int32_t s_dc_avg = 0;
#define DC_ALPHA 16  // smoothing factor (1/16 ≈ 0.06)
#define GAIN_SHIFT 3  // 3-bit left shift = 8x gain

// DFR1154 PDM microphone pins
#define PDM_CLK   GPIO_NUM_38
#define PDM_DATA  GPIO_NUM_39

void shutong_audio_init(void) {
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chan_cfg, NULL, &s_rx_chan) != ESP_OK) {
    ESP_LOGE(TAG, "Failed to create I2S channel");
    return;
  }

  i2s_pdm_rx_config_t pdm_cfg = {
    .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .clk = PDM_CLK,
      .din = PDM_DATA,
      .invert_flags = { .clk_inv = false },
    },
  };
  if (i2s_channel_init_pdm_rx_mode(s_rx_chan, &pdm_cfg) != ESP_OK) {
    ESP_LOGE(TAG, "Failed to init PDM RX mode");
    return;
  }
  i2s_channel_enable(s_rx_chan);

  s_audio_buf = heap_caps_calloc(1, AUDIO_BUF_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!s_audio_buf) {
    s_audio_buf = heap_caps_calloc(1, AUDIO_BUF_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  ESP_LOGI(TAG, "PDM mic init OK (CLK=38, DATA=39) buf=%p", (void *)s_audio_buf);
}

int shutong_audio_read(int16_t *buf, int samples) {
  if (!s_rx_chan) return 0;
  size_t bytes_read = 0;
  int collected = 0;
  while (collected < samples) {
    int chunk = samples - collected;
    if (chunk > 512) chunk = 512;
    i2s_channel_read(s_rx_chan, buf + collected, chunk * 2, &bytes_read, portMAX_DELAY);
    int read = bytes_read / 2;
    for (int i = 0; i < read; i++) {
      int16_t raw = buf[collected + i];
      // Exponential moving average for DC tracking
      s_dc_avg = s_dc_avg + ((int32_t)raw - s_dc_avg) / DC_ALPHA;
      // Remove DC and apply software gain
      int32_t ac = (int32_t)raw - s_dc_avg;
      int32_t amp = ac << GAIN_SHIFT;
      if (amp > 32767) amp = 32767;
      if (amp < -32768) amp = -32768;
      buf[collected + i] = (int16_t)amp;
      s_audio_buf[s_write_pos % (AUDIO_BUF_SIZE / 2)] = (int16_t)amp;
      s_write_pos++;
    }
    collected += read;
  }
  return collected;
}

bool shutong_audio_has_voice(const int16_t *buf, int samples) {
  if (samples <= 0) return false;
  int64_t sum = 0;
  for (int i = 0; i < samples; i++) {
    int32_t v = buf[i];
    sum += v >= 0 ? v : -v;
  }
  // After DC removal + 8x gain, silence ~0, speech > 400
  return (sum / samples) > 200;
}

size_t shutong_audio_buffer_available(void) {
  return s_write_pos;
}

int shutong_audio_buffer_read(int16_t *out, size_t max_samples) {
  size_t total = s_write_pos;
  if (total > AUDIO_BUF_SIZE / 2) total = AUDIO_BUF_SIZE / 2;
  if (max_samples < total) total = max_samples;
  for (size_t i = 0; i < total; i++) {
    out[i] = s_audio_buf[i % (AUDIO_BUF_SIZE / 2)];
  }
  return total;
}
