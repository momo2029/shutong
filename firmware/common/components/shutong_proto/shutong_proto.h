#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

// MQTT topic patterns:
//   sht/{SN}/status      - device -> server (online/heartbeat)
//   sht/{SN}/audio/chunk - device -> server (audio segments)
//   sht/{SN}/image       - device -> server (photo, flagship only)
//   sht/{SN}/cmd         - server -> device (start/stop record, reboot)
//   sht/{SN}/ota         - server -> device (firmware URL)

typedef struct {
  char sn[32];
  char fw_ver[16];
  int battery;
  int wifi_rssi;
} device_info_t;

typedef struct {
  char note_id[37];
  int seq;
  int total;
  uint8_t *data;
  size_t len;
} audio_chunk_t;

typedef enum {
  CMD_NONE = 0,
  CMD_START_RECORD,
  CMD_STOP_RECORD,
  CMD_PING,
  CMD_REBOOT,
  CMD_CAPTURE,
  CMD_TTS_PLAY,
  CMD_OTA,
} device_cmd_t;

typedef struct {
  char version[16];
  char url[512];
  size_t size;
  char sha256[65];
} ota_info_t;

// ─── 新 JSON 构建 API（返回 malloc 字符串，调用者 free） ──
// 手动构建 JSON 避免 cJSON 在大负载时的内存问题

// 构建音频 chunk JSON（base64 PCM inline）
char *shutong_build_audio_json(const char *note_id, int seq, int total,
                                const uint8_t *pcm, size_t pcm_len);

// 构建图片 JSON（base64 JPEG inline）
char *shutong_build_image_json(const char *note_id, const uint8_t *jpeg, size_t len);

// 构建 base64 编码（给其他组件用）
size_t shutong_base64_encode(const unsigned char *src, size_t slen, char *dst, size_t dlen);

// ─── 旧 API（cJSON 版本，仍用于 status/cmd_ack 等小负载） ──
#include "cJSON.h"

// Build status message JSON
cJSON *proto_build_status(const device_info_t *info);

// Init proto module (pre-allocates base64 buffer)
void shutong_proto_init(void);

// Build audio chunk message JSON (旧接口，返回空对象)
cJSON *proto_build_audio_chunk(const char *note_id, int seq, int total, const uint8_t *data, size_t len);

// Build image message JSON (旧接口，返回空对象)
cJSON *proto_build_image(const char *note_id, uint8_t *jpeg, size_t len);

// Build command ACK
cJSON *proto_build_cmd_ack(const char *msg_id, const char *result, const char *error);

// Parse incoming command
device_cmd_t proto_parse_cmd(cJSON *json, char *ref_msg_id, size_t id_len);

// Parse OTA notification
int proto_parse_ota(cJSON *json, ota_info_t *ota);
