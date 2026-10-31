#pragma once

#include <windows.h>
#include <cstdint>

namespace webmap_overlay {

constexpr uint32_t kFrameMagic = 0x314F4D57;   // WMO1
constexpr uint32_t kControlMagic = 0x31434D57; // WMC1
constexpr uint32_t kSharedVersion = 1;
constexpr uint32_t kSlotCount = 2;
constexpr uint32_t kMaxCaptureWidth = 1024;
constexpr uint32_t kMaxCaptureHeight = 1024;
constexpr uint32_t kMaxCaptureStride = kMaxCaptureWidth * 4;
constexpr uint32_t kMaxFrameBytes = kMaxCaptureStride * kMaxCaptureHeight;

constexpr wchar_t kFrameMappingName[] = L"Local\\WebMapOverlayFrameV1";
constexpr wchar_t kControlMappingName[] = L"Local\\WebMapOverlayControlV1";

struct SharedFrameSlot {
    volatile LONG64 sequence;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t size;
    uint8_t pixels[kMaxFrameBytes];
};

struct SharedFrameHeader {
    uint32_t magic;
    uint32_t version;
    uint32_t headerSize;
    uint32_t slotSize;
    volatile LONG publishedSlot;
    volatile LONG64 latestSequence;
};

struct SharedFrameMap {
    SharedFrameHeader header;
    SharedFrameSlot slots[kSlotCount];
};

enum class OverlayAnchor : uint32_t {
    BottomLeft = 0,
    TopLeft = 1,
    TopRight = 2,
    BottomRight = 3,
};

struct SharedControl {
    uint32_t magic;
    uint32_t version;
    uint32_t size;
    volatile LONG sequence;
    uint32_t visible;
    uint32_t gameActive;
    uint32_t anchor;
    float ratio;
    float opacity;
};

inline bool IsValidFrame(uint32_t width, uint32_t height, uint32_t stride, uint32_t size) {
    if (width == 0 || height == 0 || width > kMaxCaptureWidth || height > kMaxCaptureHeight) return false;
    if (stride < width * 4 || stride > kMaxCaptureStride) return false;
    if (size == 0 || size > kMaxFrameBytes || size != stride * height) return false;
    return true;
}

} // namespace webmap_overlay
