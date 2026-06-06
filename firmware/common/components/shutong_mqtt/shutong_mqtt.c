#include "shutong_mqtt.h"
#include "hmac_util.h"

#include "esp_log.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static const char *TAG = "sht-mqtt";
static esp_mqtt_client_handle_t s_client = NULL;
static char s_sn[32];
static mqtt_cmd_cb_t s_cmd_cb = NULL;
static bool s_connected = false;
static const time_t MQTT_VALID_UNIX_TIME_SECONDS = 1577836800; // 2020-01-01

#ifndef CONFIG_MQTT_USERNAME
#define CONFIG_MQTT_USERNAME "st_device"
#endif

#ifndef CONFIG_MQTT_PASSWORD
#define CONFIG_MQTT_PASSWORD ""
#endif

#ifndef CONFIG_MQTT_MASTER_KEY
#define CONFIG_MQTT_MASTER_KEY ""
#endif

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
  const char *device_sn = sn ? sn : "";

  strncpy(s_sn, device_sn, sizeof(s_sn) - 1);
  s_sn[sizeof(s_sn) - 1] = '\0';
  s_cmd_cb = cmd_cb;

  const char *username = CONFIG_MQTT_USERNAME;
  char dynamic_username[128];
  char payload[128];
  char signature[45];

  if (CONFIG_MQTT_MASTER_KEY[0] != '\0') {
    time_t timestamp = (time_t)(esp_log_timestamp() / 1000);
    time_t unix_time = time(NULL);
    if (unix_time > MQTT_VALID_UNIX_TIME_SECONDS) {
      timestamp = unix_time;
      ESP_LOGI(TAG, "Using unix timestamp for MQTT auth: %lld", (long long)timestamp);
    } else {
      ESP_LOGI(TAG, "Using uptime timestamp for MQTT auth: %lld", (long long)timestamp);
    }

    int payload_len = snprintf(payload, sizeof(payload), "st_device|%lld|%s",
                               (long long)timestamp, device_sn);
    if (payload_len > 0 && payload_len < (int)sizeof(payload)) {
      hmac_sha256_b64(CONFIG_MQTT_MASTER_KEY, payload, signature, sizeof(signature));
      if (signature[0] != '\0') {
        int username_len = snprintf(dynamic_username, sizeof(dynamic_username),
                                    "st_device:%lld:%s", (long long)timestamp,
                                    signature);
        if (username_len > 0 && username_len < (int)sizeof(dynamic_username)) {
          username = dynamic_username;
          ESP_LOGI(TAG, "Generated dynamic MQTT username, ts=%lld",
                   (long long)timestamp);
        } else {
          ESP_LOGI(TAG, "Dynamic MQTT username too long, using fallback username");
        }
      } else {
        ESP_LOGI(TAG, "MQTT auth signature failed, using fallback username");
      }
    } else {
      ESP_LOGI(TAG, "MQTT auth payload too long, using fallback username");
    }
  } else {
    ESP_LOGI(TAG, "MQTT master key is empty, using fallback username");
  }

  char client_id[48];
  snprintf(client_id, sizeof(client_id), "st_%s", device_sn);

  esp_mqtt_client_config_t cfg = {
    .broker.address.uri = broker_url,
    .credentials.username = username,
    .credentials.authentication.password = CONFIG_MQTT_PASSWORD,
    .credentials.client_id = client_id,
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
