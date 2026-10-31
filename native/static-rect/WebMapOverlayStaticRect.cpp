#include <windows.h>
#include <GL/gl.h>
#include "MinHook.h"

#ifndef GL_DRAW_FRAMEBUFFER_BINDING
#define GL_DRAW_FRAMEBUFFER_BINDING 0x8CA6
#endif
#ifndef GL_DRAW_FRAMEBUFFER
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#endif
#ifndef GL_DRAW_BUFFER
#define GL_DRAW_BUFFER 0x0C01
#endif
#ifndef GL_NONE
#define GL_NONE 0
#endif

using WglGetCurrentContext = HGLRC(WINAPI*)();
using WglSwapBuffers = BOOL(WINAPI*)(HDC);
using GlGetIntegerv = void(APIENTRY*)(GLenum, GLint*);
using GlGetBooleanv = void(APIENTRY*)(GLenum, GLboolean*);
using GlGetFloatv = void(APIENTRY*)(GLenum, GLfloat*);
using GlIsEnabled = GLboolean(APIENTRY*)(GLenum);
using GlEnable = void(APIENTRY*)(GLenum);
using GlDisable = void(APIENTRY*)(GLenum);
using GlScissor = void(APIENTRY*)(GLint, GLint, GLsizei, GLsizei);
using GlClearColor = void(APIENTRY*)(GLfloat, GLfloat, GLfloat, GLfloat);
using GlColorMask = void(APIENTRY*)(GLboolean, GLboolean, GLboolean, GLboolean);
using GlClear = void(APIENTRY*)(GLbitfield);
using GlBindFramebuffer = void(APIENTRY*)(GLenum, GLuint);

static volatile LONG g_state = 0;
static LPVOID g_target = nullptr;
static WglSwapBuffers g_originalSwapBuffers = nullptr;

template <typename T>
static T GetGlProc(const char* name) {
    HMODULE module = GetModuleHandleW(L"opengl32.dll");
    FARPROC proc = module ? GetProcAddress(module, name) : nullptr;
    if (!proc && module) {
        using WglGetProcAddress = PROC(WINAPI*)(LPCSTR);
        auto getProc = reinterpret_cast<WglGetProcAddress>(GetProcAddress(module, "wglGetProcAddress"));
        if (getProc) proc = getProc(name);
    }
    return reinterpret_cast<T>(proc);
}

static bool DrawStaticRectImpl() {
    WglGetCurrentContext getCurrentContext = GetGlProc<WglGetCurrentContext>("wglGetCurrentContext");
    GlGetIntegerv getInt = GetGlProc<GlGetIntegerv>("glGetIntegerv");
    GlGetBooleanv getBool = GetGlProc<GlGetBooleanv>("glGetBooleanv");
    GlGetFloatv getFloat = GetGlProc<GlGetFloatv>("glGetFloatv");
    GlIsEnabled isEnabled = GetGlProc<GlIsEnabled>("glIsEnabled");
    GlEnable enable = GetGlProc<GlEnable>("glEnable");
    GlDisable disable = GetGlProc<GlDisable>("glDisable");
    GlScissor scissor = GetGlProc<GlScissor>("glScissor");
    GlClearColor clearColor = GetGlProc<GlClearColor>("glClearColor");
    GlColorMask colorMask = GetGlProc<GlColorMask>("glColorMask");
    GlClear clear = GetGlProc<GlClear>("glClear");
    GlBindFramebuffer bindFramebuffer = GetGlProc<GlBindFramebuffer>("glBindFramebuffer");
    if (!getCurrentContext || !getInt || !getBool || !getFloat || !isEnabled || !enable || !disable
        || !scissor || !clearColor || !colorMask || !clear) return false;
    if (!getCurrentContext()) return false;

    GLint viewport[4]{};
    getInt(GL_VIEWPORT, viewport);
    if (viewport[2] <= 0 || viewport[3] <= 0) return false;

    GLint drawBuffer = GL_BACK;
    getInt(GL_DRAW_BUFFER, &drawBuffer);
    if (drawBuffer == GL_NONE) return false;

    GLboolean scissorWasEnabled = GL_FALSE;
    GLboolean colorWriteMask[4]{ GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE };
    GLint scissorBox[4]{};
    GLfloat savedClearColor[4]{};
    getBool(GL_SCISSOR_TEST, &scissorWasEnabled);
    getBool(GL_COLOR_WRITEMASK, colorWriteMask);
    getInt(GL_SCISSOR_BOX, scissorBox);
    getFloat(GL_COLOR_CLEAR_VALUE, savedClearColor);

    GLint drawFramebuffer = 0;
    bool changedFramebuffer = false;
    if (bindFramebuffer) {
        getInt(GL_DRAW_FRAMEBUFFER_BINDING, &drawFramebuffer);
        if (drawFramebuffer != 0) {
            bindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
            changedFramebuffer = true;
        }
    }

    const GLsizei rectWidth = viewport[2] < 128 ? viewport[2] : 128;
    const GLsizei rectHeight = viewport[3] < 128 ? viewport[3] : 128;
    enable(GL_SCISSOR_TEST);
    scissor(0, 0, rectWidth, rectHeight);
    colorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    clearColor(0.0f, 1.0f, 0.0f, 1.0f);
    clear(GL_COLOR_BUFFER_BIT);

    clearColor(savedClearColor[0], savedClearColor[1], savedClearColor[2], savedClearColor[3]);
    colorMask(colorWriteMask[0], colorWriteMask[1], colorWriteMask[2], colorWriteMask[3]);
    scissor(scissorBox[0], scissorBox[1], scissorBox[2], scissorBox[3]);
    if (scissorWasEnabled) enable(GL_SCISSOR_TEST); else disable(GL_SCISSOR_TEST);
    if (changedFramebuffer) bindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(drawFramebuffer));
    return true;
}

static bool DrawStaticRect() {
    __try {
        return DrawStaticRectImpl();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static BOOL WINAPI HookedSwapBuffers(HDC dc) {
    DrawStaticRect();
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
    status = MH_CreateHook(g_target, reinterpret_cast<LPVOID>(&HookedSwapBuffers),
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
    if (state == 1 || !g_target) return 0;
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
