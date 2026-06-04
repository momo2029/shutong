#include "shutong_audio.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "sht-audio";
static i2s_chan_handle_t s_rx_chan = NULL;

// Circular buffer: ~40 seconds at 16kHz 16-bit mono = 1,280,000 bytes
#define AUDIO_BUF_SIZE (16000 * 2 * 40)
static int16_t s_audio_buf[AUDIO_BUF_SIZE / 2];
static volatile size_t s_write_pos = 0;

void shutong_audio_init(void) {
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  i2s_new_channel(&chan_cfg, NULL, &s_rx_chan);

  i2s_std_config_t std_cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .bclk = 14,
      .ws = 21,
      .dout = I2S_GPIO_UNUSED,
      .din = 33,
      .invert_flags = { .bclk_inv = false, .mclk_inv = false, .ws_inv = false },
    },
  };
  i2s_channel_init_std_mode(s_rx_chan, &std_cfg);
  i2s_channel_enable(s_rx_chan);
  ESP_LOGI(TAG, "I2S mic init OK (SCK=14, WS=21, SD=33)");
  memset(s_audio_buf, 0, sizeof(s_audio_buf));
}

int shutong_audio_read(int16_t *buf, int samples) {
  if (!s_rx_chan) return 0;
  size_t bytes_read = 0;
  // Read as 32-bit then convert to 16-bit (INMP441 packs 24-bit in 32-bit frames)
  int32_t raw[512];
  int collected = 0;
  while (collected < samples) {
    int chunk = (samples - collected) > 512 ? 512 : (samples - collected);
    i2s_channel_read(s_rx_chan, raw, chunk * 4, &bytes_read, portMAX_DELAY);
    int read = bytes_read / 4;
    for (int i = 0; i < read; i++) {
      int16_t sample = (int16_t)(raw[i] >> 14); // shift from 24-bit to 16-bit
      buf[collected + i] = sample;
      // Write to circular buffer
      s_audio_buf[s_write_pos % (AUDIO_BUF_SIZE / 2)] = sample;
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
  return (sum / samples) > 500;
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
