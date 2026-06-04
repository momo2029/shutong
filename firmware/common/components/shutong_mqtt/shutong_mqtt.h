#pragma once
#include "mqtt_client.h"
#include <stdbool.h>
#include <stdint.h>

typedef void (*mqtt_cmd_cb_t)(const char *cmd, const char *ref_msg_id);

// Init MQTT client. Topics auto-subscribed: sht/{SN}/cmd, sht/{SN}/ota
bool shutong_mqtt_init(const char *sn, const char *broker_url, mqtt_cmd_cb_t cmd_cb);

// Publish JSON message to device topic
int shutong_mqtt_publish(const char *subtopic, const char *json);

// Publish raw binary (for small payloads — data still goes as base64 in JSON)
int shutong_mqtt_publish_bin(const char *subtopic, const char *json, size_t len);

bool shutong_mqtt_is_connected(void);
