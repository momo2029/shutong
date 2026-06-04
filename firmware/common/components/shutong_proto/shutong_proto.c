#include "shutong_proto.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <mbedtls/base64.h>

static char *get_msg_id(void) {
  static char buf[37];
  struct timeval tv;
  gettimeofday(&tv, NULL);
  snprintf(buf, sizeof(buf), "%08lx-%04x", (unsigned long)tv.tv_sec, (unsigned)tv.tv_usec);
  return buf;
}

cJSON *proto_build_status(const device_info_t *info) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "msg_id", get_msg_id());
  cJSON_AddNumberToObject(root, "ts", time(NULL));
  cJSON_AddStringToObject(root, "type", "status");
  cJSON *p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "status", "online");
  cJSON_AddStringToObject(p, "fw_ver", info->fw_ver);
  cJSON_AddNumberToObject(p, "battery", info->battery);
  cJSON_AddNumberToObject(p, "wifi_rssi", info->wifi_rssi);
  cJSON_AddItemToObject(root, "payload", p);
  return root;
}

cJSON *proto_build_audio_chunk(const char *note_id, int seq, int total, const uint8_t *data, size_t len) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "msg_id", get_msg_id());
  cJSON_AddNumberToObject(root, "ts", time(NULL));
  cJSON_AddStringToObject(root, "type", "audio_chunk");
  cJSON *p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "note_id", note_id);
  cJSON_AddNumberToObject(p, "seq", seq);
  cJSON_AddNumberToObject(p, "total", total);
  cJSON_AddStringToObject(p, "codec", "pcm");
  cJSON_AddNumberToObject(p, "sample_rate", 16000);
  // base64 encode audio data
  size_t out_len = 0;
  mbedtls_base64_encode(NULL, 0, &out_len, data, len);
  char *b64 = malloc(out_len + 1);
  mbedtls_base64_encode((unsigned char *)b64, out_len, &out_len, data, len);
  b64[out_len] = '\0';
  cJSON_AddStringToObject(p, "data", b64);
  free(b64);
  cJSON_AddItemToObject(root, "payload", p);
  return root;
}

cJSON *proto_build_image(const char *note_id, uint8_t *jpeg, size_t len) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "msg_id", get_msg_id());
  cJSON_AddNumberToObject(root, "ts", time(NULL));
  cJSON_AddStringToObject(root, "type", "image");
  cJSON *p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "note_id", note_id);
  cJSON_AddStringToObject(p, "format", "jpeg");
  cJSON_AddNumberToObject(p, "width", 800);
  cJSON_AddNumberToObject(p, "height", 600);
  cJSON_AddNumberToObject(p, "quality", 70);
  // base64 encode
  size_t out_len = 0;
  mbedtls_base64_encode(NULL, 0, &out_len, jpeg, len);
  char *b64 = malloc(out_len + 1);
  mbedtls_base64_encode((unsigned char *)b64, out_len, &out_len, jpeg, len);
  b64[out_len] = '\0';
  cJSON_AddStringToObject(p, "data", b64);
  free(b64);
  cJSON_AddItemToObject(root, "payload", p);
  return root;
}

cJSON *proto_build_cmd_ack(const char *msg_id, const char *result, const char *error) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "msg_id", get_msg_id());
  cJSON_AddNumberToObject(root, "ts", time(NULL));
  cJSON_AddStringToObject(root, "type", "cmd_ack");
  cJSON *p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "ref_msg_id", msg_id);
  cJSON_AddStringToObject(p, "result", result);
  if (error) cJSON_AddStringToObject(p, "error", error);
  cJSON_AddItemToObject(root, "payload", p);
  return root;
}

device_cmd_t proto_parse_cmd(cJSON *json, char *ref_msg_id, size_t id_len) {
  cJSON *id = cJSON_GetObjectItem(json, "msg_id");
  if (id && id->valuestring && ref_msg_id) {
    strncpy(ref_msg_id, id->valuestring, id_len);
  }
  cJSON *p = cJSON_GetObjectItem(json, "payload");
  if (!p) return CMD_NONE;

  cJSON *cmd = cJSON_GetObjectItem(p, "cmd");
  if (!cmd || !cmd->valuestring) return CMD_NONE;

  if (strcmp(cmd->valuestring, "start_record") == 0) return CMD_START_RECORD;
  if (strcmp(cmd->valuestring, "stop_record") == 0) return CMD_STOP_RECORD;
  if (strcmp(cmd->valuestring, "ping") == 0) return CMD_PING;
  if (strcmp(cmd->valuestring, "reboot") == 0) return CMD_REBOOT;
  return CMD_NONE;
}

int proto_parse_ota(cJSON *json, ota_info_t *ota) {
  cJSON *p = cJSON_GetObjectItem(json, "payload");
  if (!p) return -1;
  cJSON *v = cJSON_GetObjectItem(p, "version");
  cJSON *u = cJSON_GetObjectItem(p, "url");
  cJSON *s = cJSON_GetObjectItem(p, "size");
  cJSON *h = cJSON_GetObjectItem(p, "sha256");
  if (!v || !u) return -1;
  strncpy(ota->version, v->valuestring, sizeof(ota->version) - 1);
  strncpy(ota->url, u->valuestring, sizeof(ota->url) - 1);
  ota->size = s ? s->valueint : 0;
  if (h && h->valuestring) strncpy(ota->sha256, h->valuestring, sizeof(ota->sha256) - 1);
  return 0;
}
