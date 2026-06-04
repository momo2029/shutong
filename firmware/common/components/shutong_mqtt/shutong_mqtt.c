#include "shutong_mqtt.h"
#include "esp_log.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>

static const char *TAG = "sht-mqtt";
static esp_mqtt_client_handle_t s_client = NULL;
static char s_sn[32];
static mqtt_cmd_cb_t s_cmd_cb = NULL;
static bool s_connected = false;

static char *build_topic(const char *suffix) {
  static char topic[128];
  snprintf(topic, sizeof(topic), "sht/%s/%s", s_sn, suffix);
  return topic;
}

static void mqtt_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
  esp_mqtt_event_handle_t ev = (esp_mqtt_event_handle_t)data;
  switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
      s_connected = true;
      ESP_LOGI(TAG, "MQTT connected");
      // Subscribe to commands and OTA
      esp_mqtt_client_subscribe(s_client, build_topic("cmd"), 1);
      esp_mqtt_client_subscribe(s_client, build_topic("ota"), 1);
      break;
    case MQTT_EVENT_DISCONNECTED:
      s_connected = false;
      break;
    case MQTT_EVENT_DATA: {
      char *payload = malloc(ev->data_len + 1);
      strncpy(payload, ev->data, ev->data_len);
      payload[ev->data_len] = '\0';
      cJSON *json = cJSON_Parse(payload);
      if (json && s_cmd_cb) {
        cJSON *type = cJSON_GetObjectItem(json, "type");
        if (type && type->valuestring) {
          cJSON *id = cJSON_GetObjectItem(json, "msg_id");
          s_cmd_cb(type->valuestring, id ? id->valuestring : "");
        }
      }
      if (json) cJSON_Delete(json);
      free(payload);
      break;
    }
    default: break;
  }
}

bool shutong_mqtt_init(const char *sn, const char *broker_url, mqtt_cmd_cb_t cmd_cb) {
  strncpy(s_sn, sn, sizeof(s_sn) - 1);
  s_cmd_cb = cmd_cb;

  esp_mqtt_client_config_t cfg = {
    .broker.address.uri = broker_url,
    .session.keepalive = 30,
  };
  s_client = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
  esp_mqtt_client_start(s_client);
  return true;
}

int shutong_mqtt_publish(const char *subtopic, const char *json) {
  if (!s_client || !s_connected) return -1;
  return esp_mqtt_client_publish(s_client, build_topic(subtopic), json, 0, 1, 0);
}

int shutong_mqtt_publish_bin(const char *subtopic, const char *json, size_t len) {
  if (!s_client || !s_connected) return -1;
  return esp_mqtt_client_publish(s_client, build_topic(subtopic), json, len, 1, 0);
}

bool shutong_mqtt_is_connected(void) { return s_connected; }
