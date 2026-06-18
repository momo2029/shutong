#include "shutong_proto.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>

// ─── 工具函数 ─────────────────────────────────────────────
static char *get_msg_id(void) {
  static char buf[37];
  struct timeval tv;
  gettimeofday(&tv, NULL);
  snprintf(buf, sizeof(buf), "%08lx-%04x", (unsigned long)tv.tv_sec, (unsigned)tv.tv_usec);
  return buf;
}

void shutong_proto_init(void) {
  // 无需额外初始化
}

// ─── 简单 base64 编码 ─────────────────────────────────
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t shutong_base64_encode(const unsigned char *src, size_t slen, char *dst, size_t dlen) {
  size_t i = 0, j = 0;
  while (i < slen && j + 4 < dlen) {
    unsigned long val = 0;
    int rem = slen - i;
    if (rem >= 3) {
      val = ((unsigned long)src[i] << 16) | ((unsigned long)src[i+1] << 8) | src[i+2];
      dst[j++] = b64[(val >> 18) & 0x3F];
      dst[j++] = b64[(val >> 12) & 0x3F];
      dst[j++] = b64[(val >> 6) & 0x3F];
      dst[j++] = b64[val & 0x3F];
      i += 3;
    } else if (rem == 2) {
      val = ((unsigned long)src[i] << 16) | ((unsigned long)src[i+1] << 8);
      dst[j++] = b64[(val >> 18) & 0x3F];
      dst[j++] = b64[(val >> 12) & 0x3F];
      dst[j++] = b64[(val >> 6) & 0x3F];
      dst[j++] = '=';
      i += 2;
    } else {
      val = (unsigned long)src[i] << 16;
      dst[j++] = b64[(val >> 18) & 0x3F];
      dst[j++] = b64[(val >> 12) & 0x3F];
      dst[j++] = '=';
      dst[j++] = '=';
      i += 1;
    }
  }
  if (j < dlen) dst[j] = '\0';
  return j;
}

// ─── 手动构建 JSON（避免 cJSON 内存问题） ──────────────
char *shutong_build_audio_json(const char *note_id, int seq, int total,
                                const uint8_t *pcm, size_t pcm_len) {
  // base64 encode
  size_t b64_cap = (pcm_len + 2) / 3 * 4 + 64;
  char *b64_str = (char *)malloc(b64_cap);
  if (!b64_str) return NULL;
  size_t b64_len = shutong_base64_encode(pcm, pcm_len, b64_str, b64_cap);
  
  // Calculate JSON buffer: fixed overhead + base64 data
  // {"msg_id":"...","ts":...,"type":"audio_chunk","payload":{"note_id":"...","seq":...,"total":...,"codec":"pcm","sample_rate":16000,"data":"..."}}
  size_t json_cap = 256 + b64_len;
  char *json = (char *)malloc(json_cap);
  if (!json) { free(b64_str); return NULL; }
  
  snprintf(json, json_cap,
    "{\"msg_id\":\"%s\",\"ts\":%ld,\"type\":\"audio_chunk\","
    "\"payload\":{\"note_id\":\"%s\",\"seq\":%d,\"total\":%d,"
    "\"codec\":\"pcm\",\"sample_rate\":16000,\"data\":\"%s\"}}",
    get_msg_id(), (long)time(NULL), note_id, seq, total, b64_str);
  
  free(b64_str);
  return json;
}

char *shutong_build_image_json(const char *note_id, const uint8_t *jpeg, size_t len) {
  size_t b64_cap = (len + 2) / 3 * 4 + 64;
  char *b64_str = (char *)malloc(b64_cap);
  if (!b64_str) return NULL;
  size_t b64_len = shutong_base64_encode(jpeg, len, b64_str, b64_cap);
  
  size_t json_cap = 256 + b64_len;
  char *json = (char *)malloc(json_cap);
  if (!json) { free(b64_str); return NULL; }
  
  snprintf(json, json_cap,
    "{\"msg_id\":\"%s\",\"ts\":%ld,\"type\":\"image\","
    "\"payload\":{\"note_id\":\"%s\",\"format\":\"jpeg\","
    "\"width\":800,\"height\":600,\"quality\":70,\"data\":\"%s\"}}",
    get_msg_id(), (long)time(NULL), note_id, b64_str);
  
  free(b64_str);
  return json;
}

// ─── 旧接口兼容（需要 cJSON 才能编译，但调用者已改为新函数） ────
// 注：main.cpp 不再调用 proto 中的 cJSON 函数

// ─── Stubs for backwards compatibility ───────────────
// 这些函数不再被 main.cpp 调用。main.cpp 直接使用 shutong_build_audio_json
// 和 shutong_build_image_json。
// 保留空实现以防其他组件链接。

#include "cJSON.h"

cJSON *proto_build_status(const device_info_t *info) {
  // Status 仍然使用 cJSON，因为短小
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
  // 旧接口不再使用
  (void)note_id; (void)seq; (void)total; (void)data; (void)len;
  return cJSON_CreateObject();
}

cJSON *proto_build_image(const char *note_id, uint8_t *jpeg, size_t len) {
  // 旧接口不再使用
  (void)note_id; (void)jpeg; (void)len;
  return cJSON_CreateObject();
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
  if (strcmp(cmd->valuestring, "capture") == 0) return CMD_CAPTURE;
  if (strcmp(cmd->valuestring, "tts_play") == 0) return CMD_TTS_PLAY;
  if (strcmp(cmd->valuestring, "ota") == 0) return CMD_OTA;
  return CMD_NONE;
}

int proto_parse_ota(cJSON *json, ota_info_t *ota) {
  cJSON *p = cJSON_GetObjectItem(json, "payload");
  if (!p) return -1;

  cJSON *params = cJSON_GetObjectItem(p, "params");
  cJSON *src = (params && cJSON_IsObject(params)) ? params : p;
  cJSON *v = cJSON_GetObjectItem(src, "version");
  cJSON *u = cJSON_GetObjectItem(src, "url");
  cJSON *s = cJSON_GetObjectItem(src, "size");
  cJSON *h = cJSON_GetObjectItem(src, "sha256");
  if (!v || !u) return -1;
  strncpy(ota->version, v->valuestring, sizeof(ota->version) - 1);
  ota->version[sizeof(ota->version) - 1] = '\0';
  strncpy(ota->url, u->valuestring, sizeof(ota->url) - 1);
  ota->url[sizeof(ota->url) - 1] = '\0';
  ota->size = s ? s->valueint : 0;
  if (h && h->valuestring) {
    strncpy(ota->sha256, h->valuestring, sizeof(ota->sha256) - 1);
    ota->sha256[sizeof(ota->sha256) - 1] = '\0';
  }
  return 0;
}
