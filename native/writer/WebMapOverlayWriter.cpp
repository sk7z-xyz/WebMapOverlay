#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include "../include/WebMapOverlayShared.h"

using namespace webmap_overlay;

static HANDLE g_frameMapping = nullptr;
static SharedFrameMap* g_frameView = nullptr;
static HANDLE g_controlMapping = nullptr;
static SharedControl* g_controlView = nullptr;

static bool EnsureFrameMapping() {
    if (!g_frameMapping) {
        g_frameMapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
            static_cast<DWORD>(sizeof(SharedFrameMap)), kFrameMappingName);
    }
    if (!g_frameView && g_frameMapping) {
        g_frameView = static_cast<SharedFrameMap*>(MapViewOfFile(g_frameMapping, FILE_MAP_ALL_ACCESS, 0, 0, 0));
    }
    if (!g_frameView) return false;
    if (g_frameView->header.magic != kFrameMagic || g_frameView->header.version != kSharedVersion) {
        ZeroMemory(g_frameView, sizeof(SharedFrameMap));
        g_frameView->header.magic = kFrameMagic;
        g_frameView->header.version = kSharedVersion;
        g_frameView->header.headerSize = sizeof(SharedFrameHeader);
        g_frameView->header.slotSize = sizeof(SharedFrameSlot);
        InterlockedExchange(&g_frameView->header.publishedSlot, -1);
    }
    return true;
}

static bool EnsureControlMapping() {
    if (!g_controlMapping) {
        g_controlMapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
            static_cast<DWORD>(sizeof(SharedControl)), kControlMappingName);
    }
    if (!g_controlView && g_controlMapping) {
        g_controlView = static_cast<SharedControl*>(MapViewOfFile(g_controlMapping, FILE_MAP_ALL_ACCESS, 0, 0, 0));
    }
    if (!g_controlView) return false;
    if (g_controlView->magic != kControlMagic || g_controlView->version != kSharedVersion) {
        ZeroMemory(g_controlView, sizeof(SharedControl));
        g_controlView->magic = kControlMagic;
        g_controlView->version = kSharedVersion;
        g_controlView->size = sizeof(SharedControl);
        InterlockedExchange(&g_controlView->sequence, 1);
    }
    return true;
}

extern "C" __declspec(dllexport) int WmoInitialize() {
    return EnsureFrameMapping() && EnsureControlMapping() ? 1 : 0;
}

extern "C" __declspec(dllexport) int WmoWriteFrame(const void* data, uint32_t size, uint32_t width, uint32_t height, uint32_t stride) {
    if (!data || !IsValidFrame(width, height, stride, size) || !EnsureFrameMapping()) return 0;
    LONG published = InterlockedCompareExchange(&g_frameView->header.publishedSlot, 0, 0);
    int slotIndex = published == 0 ? 1 : 0;
    if (published < 0 || published >= static_cast<LONG>(kSlotCount)) slotIndex = 0;
    SharedFrameSlot& slot = g_frameView->slots[slotIndex];
    LONG64 sequence = InterlockedIncrement64(&slot.sequence);
    if ((sequence & 1) == 0) sequence = InterlockedIncrement64(&slot.sequence);
    for (uint32_t row = 0; row < height; ++row) {
        std::memcpy(slot.pixels + static_cast<size_t>(row) * stride,
            static_cast<const uint8_t*>(data) + static_cast<size_t>(row) * stride, stride);
    }
    slot.width = width;
    slot.height = height;
    slot.stride = stride;
    slot.size = size;
    MemoryBarrier();
    InterlockedIncrement64(&slot.sequence);
    InterlockedExchange64(&g_frameView->header.latestSequence, sequence + 1);
    InterlockedExchange(&g_frameView->header.publishedSlot, slotIndex);
    return 1;
}

extern "C" __declspec(dllexport) int WmoWriteControl(uint32_t visible, float ratio, float opacity, uint32_t anchor, uint32_t gameActive) {
    if (!EnsureControlMapping()) return 0;
    g_controlView->visible = visible ? 1u : 0u;
    g_controlView->gameActive = gameActive ? 1u : 0u;
    g_controlView->anchor = anchor <= 3 ? anchor : 0;
    g_controlView->ratio = std::clamp(ratio, 0.10f, 0.80f);
    g_controlView->opacity = std::clamp(opacity, 0.0f, 1.0f);
    MemoryBarrier();
    InterlockedIncrement(&g_controlView->sequence);
    return 1;
}

extern "C" __declspec(dllexport) int WmoResetControl() {
    return WmoWriteControl(0, 0.30f, 0.90f, 0, 0);
}

BOOL APIENTRY DllMain(HMODULE, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_DETACH) {
        if (g_frameView) UnmapViewOfFile(g_frameView);
        if (g_frameMapping) CloseHandle(g_frameMapping);
        if (g_controlView) UnmapViewOfFile(g_controlView);
        if (g_controlMapping) CloseHandle(g_controlMapping);
    }
    return TRUE;
}
