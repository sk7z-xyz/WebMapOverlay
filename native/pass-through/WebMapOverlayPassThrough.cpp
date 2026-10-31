#include <windows.h>
#include "MinHook.h"

using WglSwapBuffers = BOOL(WINAPI*)(HDC);

static volatile LONG g_state = 0;
static LPVOID g_target = nullptr;
static WglSwapBuffers g_originalSwapBuffers = nullptr;

static BOOL WINAPI PassThroughSwapBuffers(HDC dc) {
    return g_originalSwapBuffers ? g_originalSwapBuffers(dc) : FALSE;
}

extern "C" __declspec(dllexport) int WmoInitializeHook() {
    LONG state = InterlockedCompareExchange(&g_state, 0, 0);
    if (state == 2) return 1;

    if (state == 1) {
        for (int attempt = 0; attempt < 100; ++attempt) {
            Sleep(1);
            state = InterlockedCompareExchange(&g_state, 0, 0);
            if (state != 1) break;
        }
        return InterlockedCompareExchange(&g_state, 0, 0) == 2 ? 1 : 0;
    }

    if (InterlockedCompareExchange(&g_state, 1, 0) != 0) {
        return InterlockedCompareExchange(&g_state, 0, 0) == 2 ? 1 : 0;
    }

    HMODULE opengl = GetModuleHandleW(L"opengl32.dll");
    FARPROC swapBuffers = opengl ? GetProcAddress(opengl, "wglSwapBuffers") : nullptr;
    if (!swapBuffers) {
        InterlockedExchange(&g_state, -1);
        return 0;
    }

    MH_STATUS status = MH_Initialize();
    if (status != MH_OK && status != MH_ERROR_ALREADY_INITIALIZED) {
        InterlockedExchange(&g_state, -1);
        return 0;
    }

    g_target = reinterpret_cast<LPVOID>(swapBuffers);
    status = MH_CreateHook(g_target, reinterpret_cast<LPVOID>(&PassThroughSwapBuffers),
        reinterpret_cast<LPVOID*>(&g_originalSwapBuffers));
    if (status != MH_OK) {
        g_target = nullptr;
        g_originalSwapBuffers = nullptr;
        InterlockedExchange(&g_state, -1);
        return 0;
    }

    status = MH_EnableHook(g_target);
    if (status != MH_OK && status != MH_ERROR_ENABLED) {
        MH_RemoveHook(g_target);
        g_target = nullptr;
        g_originalSwapBuffers = nullptr;
        InterlockedExchange(&g_state, -1);
        return 0;
    }

    InterlockedExchange(&g_state, 2);
    return 1;
}

extern "C" __declspec(dllexport) int WmoDisableHook() {
    LONG state = InterlockedCompareExchange(&g_state, 0, 0);
    if (state == 0 || state == -1) return 1;
    if (state == 1) return 0;
    if (!g_target) return 0;

    MH_STATUS status = MH_DisableHook(g_target);
    if (status != MH_OK && status != MH_ERROR_DISABLED) return 0;
    InterlockedExchange(&g_state, 3);
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)module;
    (void)reason;
    (void)reserved;
    return TRUE;
}
