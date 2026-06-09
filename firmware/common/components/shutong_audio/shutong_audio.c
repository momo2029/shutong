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
  // PDM RX outputs 16-bit samples directly
  int collected = 0;
  while (collected < samples) {
    int chunk = samples - collected;
    if (chunk > 512) chunk = 512;
    i2s_channel_read(s_rx_chan, buf + collected, chunk * 2, &bytes_read, portMAX_DELAY);
    int read = bytes_read / 2;
    for (int i = 0; i < read; i++) {
      s_audio_buf[s_write_pos % (AUDIO_BUF_SIZE / 2)] = buf[collected + i];
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
    sum += buf[i] >= 0 ? buf[i] : -buf[i];
  }
  return (sum / samples) > 800;
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
