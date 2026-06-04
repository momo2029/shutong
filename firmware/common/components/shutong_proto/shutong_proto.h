#pragma once
#include <stdint.h>
#include <stddef.h>
#include "cJSON.h"

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
} device_cmd_t;

typedef struct {
  char version[16];
  char url[256];
  size_t size;
  char sha256[65];
} ota_info_t;

// Build status message JSON
cJSON *proto_build_status(const device_info_t *info);

// Build audio chunk message JSON
cJSON *proto_build_audio_chunk(const char *note_id, int seq, int total, const uint8_t *data, size_t len);

// Build image message JSON (base64 inline)
cJSON *proto_build_image(const char *note_id, uint8_t *jpeg, size_t len);

// Build command ACK
cJSON *proto_build_cmd_ack(const char *msg_id, const char *result, const char *error);

// Parse incoming command
device_cmd_t proto_parse_cmd(cJSON *json, char *ref_msg_id, size_t id_len);

// Parse OTA notification
int proto_parse_ota(cJSON *json, ota_info_t *ota);
