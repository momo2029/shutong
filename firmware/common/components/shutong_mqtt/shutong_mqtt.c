#include "shutong_mqtt.h"

#include "esp_log.h"
#include "nvs_flash.h"
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


#ifndef CONFIG_MQTT_USERNAME
#define CONFIG_MQTT_USERNAME "st_device"
#endif

#ifndef CONFIG_MQTT_PASSWORD
#define CONFIG_MQTT_PASSWORD "shutong-mqtt-2024"
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
      if (json) {
        cJSON *type = cJSON_GetObjectItem(json, "type");
        if (type && type->valuestring) {
          // Handle update_credentials command
          if (strcmp(type->valuestring, "update_credentials") == 0) {
            cJSON *username_obj = cJSON_GetObjectItem(json, "username");
            cJSON *password_obj = cJSON_GetObjectItem(json, "password");
            if (username_obj && username_obj->valuestring) {
              nvs_handle_t nvs_h;
              if (nvs_open("mqtt", NVS_READWRITE, &nvs_h) == ESP_OK) {
                nvs_set_str(nvs_h, "username", username_obj->valuestring);
                if (password_obj && password_obj->valuestring) {
                  nvs_set_str(nvs_h, "password", password_obj->valuestring);
                } else {
                  nvs_set_str(nvs_h, "password", "");
                }
                nvs_commit(nvs_h);
                nvs_close(nvs_h);
                ESP_LOGI(TAG, "MQTT credentials updated, restarting...");
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_restart();
              }
            }
          }
          // Forward to callback for other commands
          if (s_cmd_cb) {
            cJSON *id = cJSON_GetObjectItem(json, "msg_id");
            s_cmd_cb(type->valuestring, payload, id ? id->valuestring : "");
          }
        }
        cJSON_Delete(json);
      }
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

  // Try to read credentials from NVS first
  static char nvs_username[64] = {0};
  static char nvs_password[64] = {0};
  bool use_nvs_creds = false;

  nvs_handle_t nvs_h;
  if (nvs_open("mqtt", NVS_READONLY, &nvs_h) == ESP_OK) {
    size_t len = sizeof(nvs_username);
    if (nvs_get_str(nvs_h, "username", nvs_username, &len) == ESP_OK && nvs_username[0]) {
      len = sizeof(nvs_password);
      nvs_get_str(nvs_h, "password", nvs_password, &len);
      use_nvs_creds = true;
      ESP_LOGI(TAG, "Using MQTT credentials from NVS");
    }
    nvs_close(nvs_h);
  }

  // Auth strategy:
  // 1. If NVS has personalized credentials → use them directly
  // 2. Otherwise → use fixed default username/password (st_device)
  //    Server will detect this and send personalized credentials via
  //    update_credentials command, which saves to NVS and reboots.
  //    Dynamic auth (timestamp+HMAC) is NOT used for initial connection
  //    because EMQX's built-in database doesn't support dynamic usernames.
  const char *username = use_nvs_creds ? nvs_username : CONFIG_MQTT_USERNAME;
  const char *mqtt_password = use_nvs_creds ? nvs_password : CONFIG_MQTT_PASSWORD;

  if (use_nvs_creds) {
    ESP_LOGI(TAG, "Using personalized MQTT credentials: %s", username);
  } else {
    ESP_LOGI(TAG, "Using default MQTT credentials: %s", username);
  }

  char client_id[48];
  snprintf(client_id, sizeof(client_id), "st_%s", device_sn);

  esp_mqtt_client_config_t cfg = {
    .broker.address.uri = broker_url,
    .credentials.username = username,
    .credentials.authentication.password = mqtt_password,
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
