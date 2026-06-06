#include "hmac_util.h"

#include "mbedtls/base64.h"
#include "mbedtls/md.h"

#include <string.h>

void hmac_sha256_b64(const char *key, const char *data, char *output, size_t output_size)
{
    unsigned char hmac[32];
    unsigned char encoded[45];
    size_t encoded_len = 0;
    size_t out_len = 0;

    if (output == NULL || output_size == 0) {
        return;
    }

    output[0] = '\0';

    if (key == NULL || data == NULL) {
        return;
    }

    const mbedtls_md_info_t *md_info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (md_info == NULL) {
        return;
    }

    int ret = mbedtls_md_hmac(md_info,
                              (const unsigned char *)key,
                              strlen(key),
                              (const unsigned char *)data,
                              strlen(data),
                              hmac);
    if (ret != 0) {
        return;
    }

    ret = mbedtls_base64_encode(encoded, sizeof(encoded), &encoded_len, hmac, sizeof(hmac));
    if (ret != 0) {
        return;
    }

    for (size_t i = 0; i < encoded_len && encoded[i] != '='; i++) {
        if (out_len + 1 >= output_size) {
            break;
        }

        switch (encoded[i]) {
        case '+':
            output[out_len++] = '-';
            break;
        case '/':
            output[out_len++] = '_';
            break;
        default:
            output[out_len++] = (char)encoded[i];
            break;
        }
    }

    output[out_len] = '\0';
}
