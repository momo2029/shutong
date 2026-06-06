#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

// Init I2S PDM microphone (DFR1154: CLK=38, DATA=39)
void shutong_audio_init(void);

// Read samples: 16kHz, mono, 16-bit PCM. Returns samples read.
int shutong_audio_read(int16_t *buf, int samples);

// Simple VAD: average amplitude > threshold returns true
bool shutong_audio_has_voice(const int16_t *buf, int samples);

// Get circular buffer of recorded audio
size_t shutong_audio_buffer_available(void);
int shutong_audio_buffer_read(int16_t *out, size_t max_samples);
