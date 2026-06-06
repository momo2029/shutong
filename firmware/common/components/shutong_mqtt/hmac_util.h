#pragma once

#include <stddef.h>

void hmac_sha256_b64(const char *key, const char *data, char *output, size_t output_size);
