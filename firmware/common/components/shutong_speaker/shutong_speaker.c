#include "shutong_speaker.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sht-speaker";
static i2s_chan_handle_t s_tx_chan = NULL;

// Volume: 0.0 (mute) ~ 1.0 (full). Default 25% so it doesn't startle
static float s_volume = 0.25f;

// Embedded PCM audio files
extern const uint8_t boot_pcm[];
extern const uint32_t boot_pcm_length;
extern const uint8_t ap_mode_pcm[];
extern const uint32_t ap_mode_pcm_length;
extern const uint8_t wifi_connected_pcm[];
extern const uint32_t wifi_connected_pcm_length;

// DFR1154 MAX98357A pins
#define I2S_BCK_IO   (GPIO_NUM_45)
#define I2S_WS_IO    (GPIO_NUM_46)
#define I2S_DO_IO    (GPIO_NUM_42)
#define SAMPLE_RATE  16000

static void play_pcm(const uint8_t *pcm_data, uint32_t pcm_size) {
  if (!s_tx_chan || !pcm_data || pcm_size == 0) return;

  int16_t *mono = (int16_t *)pcm_data;
  int samples = pcm_size / 2; // 16-bit samples
  int fade_samples = SAMPLE_RATE / 10; // 100ms fade-out
  int silence_samples = SAMPLE_RATE / 10; // 100ms silence

  // Convert mono to stereo with volume scaling + fade-out + silence
  int16_t *stereo = malloc((samples + silence_samples) * 2 * sizeof(int16_t));
  if (!stereo) return;

  for (int i = 0; i < samples; i++) {
    float val = mono[i] * s_volume;

    // Apply fade-out to last fade_samples
    if (i >= samples - fade_samples) {
      int fade_pos = i - (samples - fade_samples);
      float gain = 1.0f - ((float)fade_pos / fade_samples);
      val *= gain;
    }

    // Clamp to 16-bit range
    if (val > 32767.0f) val = 32767.0f;
    if (val < -32768.0f) val = -32768.0f;

    int16_t out = (int16_t)val;
    stereo[i * 2] = out;     // Left
    stereo[i * 2 + 1] = out; // Right
  }

  // Append silence
  for (int i = samples; i < samples + silence_samples; i++) {
    stereo[i * 2] = 0;
    stereo[i * 2 + 1] = 0;
  }

  size_t written;
  i2s_channel_write(s_tx_chan, stereo, (samples + silence_samples) * 2 * sizeof(int16_t), &written, portMAX_DELAY);
  free(stereo);
}

void shutong_speaker_init(void) {
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  i2s_new_channel(&chan_cfg, &s_tx_chan, NULL);

  i2s_std_config_t std_cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = I2S_BCK_IO,
      .ws = I2S_WS_IO,
      .dout = I2S_DO_IO,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };

  i2s_channel_init_std_mode(s_tx_chan, &std_cfg);
  i2s_channel_enable(s_tx_chan);
  ESP_LOGI(TAG, "Speaker initialized");
}

void shutong_speaker_play_boot(void) {
  ESP_LOGI(TAG, "Play: boot");
  play_pcm(boot_pcm, boot_pcm_length);
}

void shutong_speaker_play_ap_mode(void) {
  ESP_LOGI(TAG, "Play: AP mode");
  play_pcm(ap_mode_pcm, ap_mode_pcm_length);
}

void shutong_speaker_play_wifi_connected(void) {
  ESP_LOGI(TAG, "Play: WiFi connected");
  play_pcm(wifi_connected_pcm, wifi_connected_pcm_length);
}

void shutong_speaker_play_short_prompt(void) {
  if (!s_tx_chan) return;

  // Generate a short 1.5kHz square wave beep, ~120ms
  int duration_samples = SAMPLE_RATE * 120 / 1000;
  int freq = 1500;
  int half_period = SAMPLE_RATE / (freq * 2);
  if (half_period < 1) half_period = 1;

  int total = duration_samples;
  int16_t *buf = malloc(total * 2 * sizeof(int16_t));
  if (!buf) return;

  for (int i = 0; i < total; i++) {
    // Square wave: alternate +amplitude / -amplitude
    int16_t val = ((i / half_period) % 2 == 0) ? 32767 : -32767;
    val = (int16_t)(val * s_volume);
    buf[i * 2] = val;
    buf[i * 2 + 1] = val;
  }

  size_t written;
  i2s_channel_write(s_tx_chan, buf, total * 2 * sizeof(int16_t), &written, portMAX_DELAY);
  free(buf);
}

void shutong_speaker_play_shutter(void) {
  if (!s_tx_chan) return;

  // Camera shutter click: 3kHz, 30ms, soft envelope
  int duration_samples = SAMPLE_RATE * 30 / 1000;
  int freq = 3000;
  int half_period = SAMPLE_RATE / (freq * 2);
  if (half_period < 1) half_period = 1;

  int total = duration_samples;
  int16_t *buf = malloc(total * 2 * sizeof(int16_t));
  if (!buf) return;

  int fade_in = SAMPLE_RATE * 5 / 1000;
  int fade_out = SAMPLE_RATE * 10 / 1000;
  for (int i = 0; i < total; i++) {
    int16_t val = ((i / half_period) % 2 == 0) ? 32767 : -32767;
    // Fade in/out to avoid click pop
    if (i < fade_in) {
      val = (int16_t)(val * (float)i / fade_in);
    } else if (i > total - fade_out) {
      val = (int16_t)(val * (float)(total - i) / fade_out);
    }
    val = (int16_t)(val * s_volume);
    buf[i * 2] = val;
    buf[i * 2 + 1] = val;
  }

  size_t written;
  i2s_channel_write(s_tx_chan, buf, total * 2 * sizeof(int16_t), &written, portMAX_DELAY);
  free(buf);
}

void shutong_speaker_set_volume(float vol) {
  if (vol < 0.0f) vol = 0.0f;
  if (vol > 1.0f) vol = 1.0f;
  s_volume = vol;
  ESP_LOGI(TAG, "Volume set to %.2f", s_volume);
}

void shutong_speaker_deinit(void) {
  if (s_tx_chan) {
    i2s_channel_disable(s_tx_chan);
    i2s_del_channel(s_tx_chan);
    s_tx_chan = NULL;
  }
}
