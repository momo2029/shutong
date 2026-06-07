#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// 初始化检测模块（分配内存、初始化人脸检测模型）
void shutong_detect_init(void);

// 帧差检测：解码 JPEG 为小尺寸灰度图并与上一帧比较
// 返回 true = 画面有明显变化
// 注意：内部会更新参考帧，每次调用都会消耗上一帧
bool shutong_detect_frame_diff(const uint8_t *jpeg, size_t jpeg_len);

// 人脸检测：解码 JPEG 为 RGB 后运行 MTMN 模型
// 返回 true = 检测到人脸
// 若未编译人脸检测（CONFIG_SHUTONG_FACE_DETECT 未定义），始终返回 true
bool shutong_detect_has_face(const uint8_t *jpeg, size_t jpeg_len);

// 重置帧差参考帧（用于场景切换后避免误检）
void shutong_detect_reset(void);

#ifdef __cplusplus
}
#endif
