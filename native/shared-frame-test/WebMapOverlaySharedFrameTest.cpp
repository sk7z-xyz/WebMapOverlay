#include <windows.h>
#include <GL/gl.h>
#include <cstdint>
#include "../include/WebMapOverlayShared.h"
#include "MinHook.h"

#ifndef GL_CURRENT_PROGRAM
#define GL_CURRENT_PROGRAM 0x8B8D
#endif
#ifndef GL_ACTIVE_TEXTURE
#define GL_ACTIVE_TEXTURE 0x84E0
#endif
#ifndef GL_TEXTURE0
#define GL_TEXTURE0 0x84C0
#endif
#ifndef GL_DRAW_FRAMEBUFFER_BINDING
#define GL_DRAW_FRAMEBUFFER_BINDING 0x8CA6
#endif
#ifndef GL_BGRA
#define GL_BGRA 0x80E1
#endif
#ifndef GL_DRAW_FRAMEBUFFER
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#endif
#ifndef GL_TEXTURE_ENV_MODE
#define GL_TEXTURE_ENV_MODE 0x2200
#endif
#ifndef GL_BLEND_COLOR
#define GL_BLEND_COLOR 0x8005
#endif
#ifndef GL_CONSTANT_ALPHA
#define GL_CONSTANT_ALPHA 0x8003
#endif
#ifndef GL_ONE_MINUS_CONSTANT_ALPHA
#define GL_ONE_MINUS_CONSTANT_ALPHA 0x8004
#endif
#ifndef GL_DRAW_BUFFER
#define GL_DRAW_BUFFER 0x0C01
#endif
#ifndef GL_NONE
#define GL_NONE 0
#endif

using namespace webmap_overlay;

using WglGetCurrentContext = HGLRC(WINAPI*)();
using WglSwapBuffers = BOOL(WINAPI*)(HDC);
using GlGetIntegerv = void(APIENTRY*)(GLenum, GLint*);
using GlGetBooleanv = void(APIENTRY*)(GLenum, GLboolean*);
using GlGetFloatv = void(APIENTRY*)(GLenum, GLfloat*);
using GlGetTexEnviv = void(APIENTRY*)(GLenum, GLenum, GLint*);
using GlIsEnabled = GLboolean(APIENTRY*)(GLenum);
using GlUseProgram = void(APIENTRY*)(GLuint);
using GlActiveTexture = void(APIENTRY*)(GLenum);
using GlBindTexture = void(APIENTRY*)(GLenum, GLuint);
using GlGenTextures = void(APIENTRY*)(GLsizei, GLuint*);
using GlTexParameteri = void(APIENTRY*)(GLenum, GLenum, GLint);
using GlTexEnvi = void(APIENTRY*)(GLenum, GLenum, GLint);
using GlTexImage2D = void(APIENTRY*)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
using GlTexSubImage2D = void(APIENTRY*)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void*);
using GlEnable = void(APIENTRY*)(GLenum);
using GlDisable = void(APIENTRY*)(GLenum);
using GlBlendFunc = void(APIENTRY*)(GLenum, GLenum);
using GlBlendColor = void(APIENTRY*)(GLfloat, GLfloat, GLfloat, GLfloat);
using GlDepthMask = void(APIENTRY*)(GLboolean);
using GlColor4f = void(APIENTRY*)(GLfloat, GLfloat, GLfloat, GLfloat);
using GlColorMask = void(APIENTRY*)(GLboolean, GLboolean, GLboolean, GLboolean);
using GlScissor = void(APIENTRY*)(GLint, GLint, GLsizei, GLsizei);
using GlViewport = void(APIENTRY*)(GLint, GLint, GLsizei, GLsizei);
using GlMatrixMode = void(APIENTRY*)(GLenum);
using GlPushMatrix = void(APIENTRY*)();
using GlPopMatrix = void(APIENTRY*)();
using GlLoadIdentity = void(APIENTRY*)();
using GlOrtho = void(APIENTRY*)(GLdouble, GLdouble, GLdouble, GLdouble, GLdouble, GLdouble);
using GlBegin = void(APIENTRY*)(GLenum);
using GlEnd = void(APIENTRY*)();
using GlTexCoord2f = void(APIENTRY*)(GLfloat, GLfloat);
using GlVertex2f = void(APIENTRY*)(GLfloat, GLfloat);
using GlBindFramebuffer = void(APIENTRY*)(GLenum, GLuint);

static volatile LONG g_state = 0;
static LPVOID g_target = nullptr;
static WglSwapBuffers g_originalSwapBuffers = nullptr;
static HANDLE g_frameMapping = nullptr;
static SharedFrameMap* g_frameView = nullptr;
static HANDLE g_controlMapping = nullptr;
static SharedControl* g_controlView = nullptr;
static uint8_t* g_frameCopy = nullptr;
static uint32_t g_frameWidth = 0;
static uint32_t g_frameHeight = 0;
static LONG64 g_frameSequence = 0;
static bool g_frameReady = false;
static CRITICAL_SECTION g_frameLock{};

struct ContextTexture {
    HGLRC context = nullptr;
    GLuint texture = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    LONG64 uploadedSequence = 0;
};
constexpr uint32_t kMaxContextTextures = 8;
static ContextTexture g_contextTextures[kMaxContextTextures]{};

struct SavedGlState {
    GLint currentProgram = 0;
    GLint activeTexture = GL_TEXTURE0;
    GLint originalTextureBinding = 0;
    GLint unit0TextureBinding = 0;
    GLint matrixMode = GL_MODELVIEW;
    GLint viewport[4]{};
    GLint scissorBox[4]{};
    GLint blendSource = GL_ONE;
    GLint blendDestination = GL_ZERO;
    GLint drawFramebuffer = 0;
    GLint drawBuffer = GL_BACK;
    GLint unit0TextureEnvMode = GL_MODULATE;
    GLboolean originalTexture2d = GL_FALSE;
    GLboolean unit0Texture2d = GL_FALSE;
    GLboolean blend = GL_FALSE;
    GLboolean depth = GL_FALSE;
    GLboolean scissor = GL_FALSE;
    GLboolean cull = GL_FALSE;
    GLboolean depthMask = GL_TRUE;
    GLboolean colorMask[4]{ GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE };
    GLfloat color[4]{ 1.0f, 1.0f, 1.0f, 1.0f };
    GLfloat blendColor[4]{ 0.0f, 0.0f, 0.0f, 0.0f };
    bool changedFramebuffer = false;
};

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

static bool EnsureMappings() {
    constexpr DWORD kMappingAccess = FILE_MAP_READ | FILE_MAP_WRITE;
    if (!g_frameMapping) g_frameMapping = OpenFileMappingW(kMappingAccess, FALSE, kFrameMappingName);
    if (!g_frameView && g_frameMapping) {
        g_frameView = static_cast<SharedFrameMap*>(MapViewOfFile(g_frameMapping, kMappingAccess, 0, 0, 0));
        if (!g_frameView) {
            CloseHandle(g_frameMapping);
            g_frameMapping = nullptr;
        }
    }
    if (!g_controlMapping) g_controlMapping = OpenFileMappingW(kMappingAccess, FALSE, kControlMappingName);
    if (!g_controlView && g_controlMapping) {
        g_controlView = static_cast<SharedControl*>(MapViewOfFile(g_controlMapping, kMappingAccess, 0, 0, 0));
        if (!g_controlView) {
            CloseHandle(g_controlMapping);
            g_controlMapping = nullptr;
        }
    }
    return g_frameView != nullptr && g_controlView != nullptr;
}

static bool ReadControl(SharedControl& control) {
    if (!EnsureMappings() || g_controlView->magic != kControlMagic || g_controlView->version != kSharedVersion
        || g_controlView->size != sizeof(SharedControl)) return false;
    for (int attempt = 0; attempt < 2; ++attempt) {
        LONG first = InterlockedCompareExchange(const_cast<LONG*>(&g_controlView->sequence), 0, 0);
        control = *g_controlView;
        MemoryBarrier();
        LONG second = InterlockedCompareExchange(const_cast<LONG*>(&g_controlView->sequence), 0, 0);
        if (first == second) return true;
    }
    return false;
}

static bool ReadLatestFrame() {
    if (!g_frameCopy || !EnsureMappings() || g_frameView->header.magic != kFrameMagic
        || g_frameView->header.version != kSharedVersion
        || g_frameView->header.headerSize != sizeof(SharedFrameHeader)
        || g_frameView->header.slotSize != sizeof(SharedFrameSlot)) {
        g_frameReady = false;
        return false;
    }
    for (int attempt = 0; attempt < 2; ++attempt) {
        LONG slotIndex = InterlockedCompareExchange(const_cast<LONG*>(&g_frameView->header.publishedSlot), 0, 0);
        if (slotIndex < 0 || slotIndex >= static_cast<LONG>(kSlotCount)) {
            g_frameReady = false;
            return false;
        }
        const SharedFrameSlot& slot = g_frameView->slots[slotIndex];
        LONG64 first = InterlockedCompareExchange64(const_cast<LONG64*>(&slot.sequence), 0, 0);
        if ((first & 1) != 0 || first == 0) {
            g_frameReady = false;
            return false;
        }
        if (first == g_frameSequence) return false;
        uint32_t width = slot.width;
        uint32_t height = slot.height;
        uint32_t stride = slot.stride;
        uint32_t size = slot.size;
        if (!IsValidFrame(width, height, stride, size)) {
            g_frameReady = false;
            g_frameSequence = first;
            return false;
        }
        uint32_t packedStride = width * 4;
        uint32_t packedSize = packedStride * height;
        if (packedSize > kMaxFrameBytes) {
            g_frameReady = false;
            g_frameSequence = first;
            return false;
        }
        for (uint32_t row = 0; row < height; ++row) {
            CopyMemory(g_frameCopy + static_cast<size_t>(row) * packedStride,
                slot.pixels + static_cast<size_t>(row) * stride, packedStride);
        }
        MemoryBarrier();
        LONG64 second = InterlockedCompareExchange64(const_cast<LONG64*>(&slot.sequence), 0, 0);
        if (first == second && (second & 1) == 0) {
            g_frameWidth = width;
            g_frameHeight = height;
            g_frameSequence = second;
            g_frameReady = true;
            return true;
        }
    }
    return false;
}

static ContextTexture* FindContextTexture(HGLRC context) {
    for (uint32_t index = 0; index < kMaxContextTextures; ++index) {
        if (g_contextTextures[index].context == context) return &g_contextTextures[index];
    }
    for (uint32_t index = 0; index < kMaxContextTextures; ++index) {
        if (!g_contextTextures[index].context) {
            g_contextTextures[index].context = context;
            return &g_contextTextures[index];
        }
    }
    return nullptr;
}

static void RestoreGlState(const SavedGlState& saved, GlUseProgram useProgram, GlActiveTexture active, GlBindTexture bindTexture,
    GlEnable enable, GlDisable disable, GlBlendFunc blendFunc, GlDepthMask depthMask, GlColor4f color,
    GlBlendColor blendColor, GlColorMask colorMask, GlScissor scissor, GlMatrixMode matrixMode, GlViewport viewport,
    GlBindFramebuffer bindFramebuffer, GlTexEnvi texEnvi) {
    if (matrixMode) matrixMode(saved.matrixMode);
    if (viewport) viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
    if (color) color(saved.color[0], saved.color[1], saved.color[2], saved.color[3]);
    if (blendColor) blendColor(saved.blendColor[0], saved.blendColor[1], saved.blendColor[2], saved.blendColor[3]);
    if (colorMask) colorMask(saved.colorMask[0], saved.colorMask[1], saved.colorMask[2], saved.colorMask[3]);
    if (blendFunc) blendFunc(static_cast<GLenum>(saved.blendSource), static_cast<GLenum>(saved.blendDestination));
    if (depthMask) depthMask(saved.depthMask);
    if (saved.blend) enable(GL_BLEND); else disable(GL_BLEND);
    if (saved.depth) enable(GL_DEPTH_TEST); else disable(GL_DEPTH_TEST);
    if (saved.scissor) enable(GL_SCISSOR_TEST); else disable(GL_SCISSOR_TEST);
    if (saved.cull) enable(GL_CULL_FACE); else disable(GL_CULL_FACE);
    if (scissor) scissor(saved.scissorBox[0], saved.scissorBox[1], saved.scissorBox[2], saved.scissorBox[3]);
    if (active) active(GL_TEXTURE0);
    if (bindTexture) bindTexture(GL_TEXTURE_2D, static_cast<GLuint>(saved.unit0TextureBinding));
    if (saved.unit0Texture2d) enable(GL_TEXTURE_2D); else disable(GL_TEXTURE_2D);
    if (texEnvi) texEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, saved.unit0TextureEnvMode);
    if (active) active(static_cast<GLenum>(saved.activeTexture));
    if (bindTexture) bindTexture(GL_TEXTURE_2D, static_cast<GLuint>(saved.originalTextureBinding));
    if (saved.originalTexture2d) enable(GL_TEXTURE_2D); else disable(GL_TEXTURE_2D);
    if (bindFramebuffer && saved.changedFramebuffer) {
        bindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(saved.drawFramebuffer));
    }
    if (useProgram) useProgram(static_cast<GLuint>(saved.currentProgram));
}

static bool DrawStaticFrameImpl() {
    WglGetCurrentContext getCurrentContext = GetGlProc<WglGetCurrentContext>("wglGetCurrentContext");
    GlGetIntegerv getInt = GetGlProc<GlGetIntegerv>("glGetIntegerv");
    GlGetBooleanv getBool = GetGlProc<GlGetBooleanv>("glGetBooleanv");
    GlGetFloatv getFloat = GetGlProc<GlGetFloatv>("glGetFloatv");
    GlGetTexEnviv getTexEnv = GetGlProc<GlGetTexEnviv>("glGetTexEnviv");
    GlUseProgram useProgram = GetGlProc<GlUseProgram>("glUseProgram");
    GlActiveTexture activeTexture = GetGlProc<GlActiveTexture>("glActiveTexture");
    GlBindTexture bindTexture = GetGlProc<GlBindTexture>("glBindTexture");
    GlGenTextures genTextures = GetGlProc<GlGenTextures>("glGenTextures");
    GlTexParameteri texParameteri = GetGlProc<GlTexParameteri>("glTexParameteri");
    GlTexEnvi texEnvi = GetGlProc<GlTexEnvi>("glTexEnvi");
    GlTexImage2D texImage = GetGlProc<GlTexImage2D>("glTexImage2D");
    GlTexSubImage2D texSubImage = GetGlProc<GlTexSubImage2D>("glTexSubImage2D");
    GlEnable enable = GetGlProc<GlEnable>("glEnable");
    GlDisable disable = GetGlProc<GlDisable>("glDisable");
    GlBlendFunc blendFunc = GetGlProc<GlBlendFunc>("glBlendFunc");
    GlBlendColor blendColor = GetGlProc<GlBlendColor>("glBlendColor");
    GlDepthMask depthMask = GetGlProc<GlDepthMask>("glDepthMask");
    GlColor4f color = GetGlProc<GlColor4f>("glColor4f");
    GlColorMask colorMask = GetGlProc<GlColorMask>("glColorMask");
    GlScissor scissor = GetGlProc<GlScissor>("glScissor");
    GlMatrixMode matrixMode = GetGlProc<GlMatrixMode>("glMatrixMode");
    GlPushMatrix pushMatrix = GetGlProc<GlPushMatrix>("glPushMatrix");
    GlPopMatrix popMatrix = GetGlProc<GlPopMatrix>("glPopMatrix");
    GlLoadIdentity loadIdentity = GetGlProc<GlLoadIdentity>("glLoadIdentity");
    GlOrtho ortho = GetGlProc<GlOrtho>("glOrtho");
    GlBegin begin = GetGlProc<GlBegin>("glBegin");
    GlEnd end = GetGlProc<GlEnd>("glEnd");
    GlTexCoord2f texCoord = GetGlProc<GlTexCoord2f>("glTexCoord2f");
    GlVertex2f vertex = GetGlProc<GlVertex2f>("glVertex2f");
    GlBindFramebuffer bindFramebuffer = GetGlProc<GlBindFramebuffer>("glBindFramebuffer");
    if (!getCurrentContext || !getInt || !getBool || !getFloat || !activeTexture || !bindTexture || !genTextures
        || !texParameteri || !texEnvi || !texImage || !texSubImage || !enable || !disable || !blendFunc
        || !depthMask || !color || !colorMask || !scissor || !matrixMode || !pushMatrix || !popMatrix
        || !loadIdentity || !ortho || !begin || !end || !texCoord || !vertex || !g_frameCopy) return false;
    if (!getCurrentContext()) return false;

    SharedControl control{};
    if (!ReadControl(control) || !control.visible || !control.gameActive) return false;
    ReadLatestFrame();
    if (!g_frameReady || !g_frameWidth || !g_frameHeight) return false;

    SavedGlState saved{};
    bool activeSaved = false;
    bool activeChanged = false;
    bool stateSaved = false;
    bool projectionPushed = false;
    bool modelviewPushed = false;
    bool success = false;
    __try {
        getInt(GL_VIEWPORT, saved.viewport);
        if (saved.viewport[2] <= 0 || saved.viewport[3] <= 0) __leave;
        getInt(GL_DRAW_BUFFER, &saved.drawBuffer);
        if (saved.drawBuffer == GL_NONE) __leave;
        getInt(GL_CURRENT_PROGRAM, &saved.currentProgram);
        getInt(GL_ACTIVE_TEXTURE, &saved.activeTexture);
        getInt(GL_MATRIX_MODE, &saved.matrixMode);
        getInt(GL_SCISSOR_BOX, saved.scissorBox);
        getInt(GL_BLEND_SRC, &saved.blendSource);
        getInt(GL_BLEND_DST, &saved.blendDestination);
        getBool(GL_BLEND, &saved.blend);
        getBool(GL_DEPTH_TEST, &saved.depth);
        getBool(GL_SCISSOR_TEST, &saved.scissor);
        getBool(GL_CULL_FACE, &saved.cull);
        getBool(GL_DEPTH_WRITEMASK, &saved.depthMask);
        getBool(GL_COLOR_WRITEMASK, saved.colorMask);
        getFloat(GL_CURRENT_COLOR, saved.color);
#ifdef WEBMAP_OVERLAY_HOOK_FULL
        if (!blendColor) __leave;
        getFloat(GL_BLEND_COLOR, saved.blendColor);
#endif

        activeSaved = true;
        activeChanged = true;
        activeTexture(GL_TEXTURE0);
        getInt(GL_TEXTURE_BINDING_2D, &saved.unit0TextureBinding);
        getBool(GL_TEXTURE_2D, &saved.unit0Texture2d);
        getTexEnv(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, &saved.unit0TextureEnvMode);
        activeTexture(static_cast<GLenum>(saved.activeTexture));
        if (saved.activeTexture == GL_TEXTURE0) {
            saved.originalTextureBinding = saved.unit0TextureBinding;
            saved.originalTexture2d = saved.unit0Texture2d;
        } else {
            getInt(GL_TEXTURE_BINDING_2D, &saved.originalTextureBinding);
            getBool(GL_TEXTURE_2D, &saved.originalTexture2d);
        }
        activeChanged = false;
        if (bindFramebuffer) {
            getInt(GL_DRAW_FRAMEBUFFER_BINDING, &saved.drawFramebuffer);
            if (saved.drawFramebuffer != 0) saved.changedFramebuffer = true;
        }
        stateSaved = true;

        HGLRC context = getCurrentContext();
        ContextTexture* contextTexture = FindContextTexture(context);
        if (!contextTexture) __leave;
        if (saved.changedFramebuffer) bindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        activeTexture(GL_TEXTURE0);
        if (!contextTexture->texture) genTextures(1, &contextTexture->texture);
        if (!contextTexture->texture) __leave;
        bindTexture(GL_TEXTURE_2D, contextTexture->texture);
        texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        bool sizeChanged = contextTexture->width != g_frameWidth || contextTexture->height != g_frameHeight;
        if (sizeChanged) {
            texImage(GL_TEXTURE_2D, 0, GL_RGBA, static_cast<GLsizei>(g_frameWidth), static_cast<GLsizei>(g_frameHeight),
                0, GL_BGRA, GL_UNSIGNED_BYTE, g_frameCopy);
            contextTexture->width = g_frameWidth;
            contextTexture->height = g_frameHeight;
            contextTexture->uploadedSequence = g_frameSequence;
        } else if (contextTexture->uploadedSequence != g_frameSequence) {
            texSubImage(GL_TEXTURE_2D, 0, 0, 0, static_cast<GLsizei>(g_frameWidth), static_cast<GLsizei>(g_frameHeight),
                GL_BGRA, GL_UNSIGNED_BYTE, g_frameCopy);
            contextTexture->uploadedSequence = g_frameSequence;
        }
        if (useProgram && saved.currentProgram != 0) useProgram(0);
        enable(GL_TEXTURE_2D);
        disable(GL_DEPTH_TEST);
        disable(GL_SCISSOR_TEST);
        disable(GL_CULL_FACE);
        enable(GL_BLEND);
#ifdef WEBMAP_OVERLAY_HOOK_FULL
        const GLfloat opacity = control.opacity < 0.0f ? 0.0f : (control.opacity > 1.0f ? 1.0f : control.opacity);
        blendColor(0.0f, 0.0f, 0.0f, opacity);
        blendFunc(GL_CONSTANT_ALPHA, GL_ONE_MINUS_CONSTANT_ALPHA);
#else
        blendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
#endif
        depthMask(GL_FALSE);
        colorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        color(1.0f, 1.0f, 1.0f, 1.0f);
#ifdef WEBMAP_OVERLAY_HOOK_FULL
        // Multiply the frame alpha by the configured overlay opacity.
        texEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
#else
        texEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
#endif

        matrixMode(GL_PROJECTION);
        pushMatrix();
        projectionPushed = true;
        loadIdentity();
        matrixMode(GL_MODELVIEW);
        pushMatrix();
        modelviewPushed = true;
        loadIdentity();
        ortho(saved.viewport[0], saved.viewport[0] + saved.viewport[2], saved.viewport[1],
            saved.viewport[1] + saved.viewport[3], -1.0, 1.0);
        const GLfloat width = static_cast<GLfloat>(g_frameWidth);
        const GLfloat height = static_cast<GLfloat>(g_frameHeight);
#ifdef WEBMAP_OVERLAY_HOOK_FULL
        const GLfloat minimumDimension = static_cast<GLfloat>(saved.viewport[2] < saved.viewport[3]
            ? saved.viewport[2] : saved.viewport[3]);
        const GLfloat ratio = control.ratio < 0.10f ? 0.10f : (control.ratio > 0.80f ? 0.80f : control.ratio);
        const GLfloat size = minimumDimension * ratio < 160.0f
            ? 160.0f : (minimumDimension * ratio > minimumDimension ? minimumDimension : minimumDimension * ratio);
        const GLfloat margin = size * 0.075f > 16.0f ? size * 0.075f : 16.0f;
        const bool right = control.anchor == static_cast<uint32_t>(OverlayAnchor::TopRight)
            || control.anchor == static_cast<uint32_t>(OverlayAnchor::BottomRight);
        const bool top = control.anchor == static_cast<uint32_t>(OverlayAnchor::TopLeft)
            || control.anchor == static_cast<uint32_t>(OverlayAnchor::TopRight);
        const GLfloat left = right ? static_cast<GLfloat>(saved.viewport[0] + saved.viewport[2]) - margin - size
            : static_cast<GLfloat>(saved.viewport[0]) + margin;
        const GLfloat bottom = top ? static_cast<GLfloat>(saved.viewport[1] + saved.viewport[3]) - margin - size
            : static_cast<GLfloat>(saved.viewport[1]) + margin;
        color(1.0f, 1.0f, 1.0f, 1.0f);
#else
        const GLfloat size = (saved.viewport[2] < 256 || saved.viewport[3] < 256)
            ? static_cast<GLfloat>(saved.viewport[2] < saved.viewport[3] ? saved.viewport[2] : saved.viewport[3])
            : 256.0f;
        const GLfloat left = static_cast<GLfloat>(saved.viewport[0]);
        const GLfloat bottom = static_cast<GLfloat>(saved.viewport[1]);
#endif
        begin(GL_QUADS);
        texCoord(0.0f, 1.0f); vertex(left, bottom);
        texCoord(1.0f, 1.0f); vertex(left + size, bottom);
        texCoord(1.0f, 0.0f); vertex(left + size, bottom + size);
        texCoord(0.0f, 0.0f); vertex(left, bottom + size);
        end();
        popMatrix();
        modelviewPushed = false;
        matrixMode(GL_PROJECTION);
        popMatrix();
        projectionPushed = false;
        success = true;
    } __finally {
        if (modelviewPushed) {
            matrixMode(GL_MODELVIEW);
            popMatrix();
        }
        if (projectionPushed) {
            matrixMode(GL_PROJECTION);
            popMatrix();
        }
        if (stateSaved) {
            RestoreGlState(saved, useProgram, activeTexture, bindTexture, enable, disable, blendFunc, depthMask, color, blendColor,
                colorMask, scissor, matrixMode, GetGlProc<GlViewport>("glViewport"), bindFramebuffer, texEnvi);
        } else if (activeChanged && activeSaved) {
            activeTexture(static_cast<GLenum>(saved.activeTexture));
        }
    }
    return success;
}

static bool DrawStaticFrame() {
    __try {
        return DrawStaticFrameImpl();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static BOOL WINAPI HookedSwapBuffers(HDC dc) {
    if (InterlockedCompareExchange(&g_state, 0, 0) == 2) {
        EnterCriticalSection(&g_frameLock);
        DrawStaticFrame();
        LeaveCriticalSection(&g_frameLock);
    }
    return g_originalSwapBuffers ? g_originalSwapBuffers(dc) : FALSE;
}

extern "C" __declspec(dllexport) int WmoInitializeHook() {
    LONG state = InterlockedCompareExchange(&g_state, 0, 0);
    if (state == 2) return 1;
    if (state == 3 && g_target) {
        MH_STATUS resume = MH_EnableHook(g_target);
        if (resume == MH_OK || resume == MH_ERROR_ENABLED) {
            InterlockedExchange(&g_state, 2);
            return 1;
        }
        return 0;
    }
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

    g_frameCopy = static_cast<uint8_t*>(VirtualAlloc(nullptr, kMaxFrameBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
    if (!g_frameCopy) {
        InterlockedExchange(&g_state, -1);
        return 0;
    }
    InitializeCriticalSection(&g_frameLock);

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
