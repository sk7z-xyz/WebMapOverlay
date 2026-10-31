#include <windows.h>
#include <tlhelp32.h>
#include <cstdint>
#include <iostream>
#include <string>

static void PrintError(const char* text) {
    std::cout << text << std::endl;
}

static bool IsStormworksProcess(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    wchar_t path[MAX_PATH]{};
    DWORD length = MAX_PATH;
    bool ok = QueryFullProcessImageNameW(process, 0, path, &length) != FALSE;
    CloseHandle(process);
    if (!ok) return false;
    const wchar_t* fileName = wcsrchr(path, L'\\');
    fileName = fileName ? fileName + 1 : path;
    return _wcsicmp(fileName, L"stormworks64.exe") == 0;
}

static bool GetAbsolutePath(const std::wstring& input, std::wstring& output) {
    DWORD capacity = MAX_PATH;
    for (int attempt = 0; attempt < 4; ++attempt) {
        std::wstring buffer(capacity, L'\0');
        DWORD written = GetFullPathNameW(input.c_str(), capacity, buffer.data(), nullptr);
        if (!written) return false;
        if (written < capacity) {
            buffer.resize(written);
            output = std::move(buffer);
            return true;
        }
        capacity = written + 1;
    }
    return false;
}

struct RemoteModule {
    uintptr_t base = 0;
    DWORD size = 0;
};

static bool FindRemoteModule(DWORD pid, const std::wstring& absolutePath, RemoteModule& result) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    MODULEENTRY32W module{};
    module.dwSize = sizeof(module);
    bool found = false;
    if (Module32FirstW(snapshot, &module)) {
        do {
            if (_wcsicmp(module.szExePath, absolutePath.c_str()) == 0) {
                result.base = reinterpret_cast<uintptr_t>(module.modBaseAddr);
                result.size = module.modBaseSize;
                found = result.base != 0 && result.size != 0;
                break;
            }
        } while (Module32NextW(snapshot, &module));
    }
    CloseHandle(snapshot);
    return found;
}

static bool IsLegacyHookLoaded(DWORD pid) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    MODULEENTRY32W module{};
    module.dwSize = sizeof(module);
    bool found = false;
    if (Module32FirstW(snapshot, &module)) {
        do {
            if (_wcsicmp(module.szModule, L"WebMapOverlayHook.dll") == 0) {
                found = true;
                break;
            }
        } while (Module32NextW(snapshot, &module));
    }
    CloseHandle(snapshot);
    return found;
}

static DWORD GetLoadedImageSize(HMODULE module) {
    if (!module) return 0;
    const auto* base = reinterpret_cast<const unsigned char*>(module);
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 0x100000) return 0;
    const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return 0;
    return nt->OptionalHeader.SizeOfImage;
}

static bool GetExportRva(const std::wstring& absolutePath, const std::wstring& exportName, uintptr_t& rva) {
    std::string name;
    name.reserve(exportName.size());
    for (wchar_t character : exportName) {
        if (character <= 0 || character > 0x7F) return false;
        name.push_back(static_cast<char>(character));
    }
    if (name.empty()) return false;

    HMODULE localModule = LoadLibraryExW(absolutePath.c_str(), nullptr, DONT_RESOLVE_DLL_REFERENCES);
    if (!localModule) return false;
    FARPROC localExport = GetProcAddress(localModule, name.c_str());
    DWORD imageSize = GetLoadedImageSize(localModule);
    uintptr_t moduleBase = reinterpret_cast<uintptr_t>(localModule);
    uintptr_t exportAddress = reinterpret_cast<uintptr_t>(localExport);
    bool valid = localExport != nullptr && imageSize != 0 && exportAddress >= moduleBase
        && exportAddress - moduleBase < imageSize;
    if (valid) rva = exportAddress - moduleBase;
    FreeLibrary(localModule);
    return valid;
}

static bool WaitForThread(HANDLE thread, DWORD& exitCode) {
    DWORD waitResult = WaitForSingleObject(thread, 5000);
    if (waitResult != WAIT_OBJECT_0) return false;
    return GetExitCodeThread(thread, &exitCode) != FALSE;
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 3 && argc != 4) {
        PrintError("invalid arguments");
        return 2;
    }
    wchar_t* end = nullptr;
    unsigned long parsedPid = wcstoul(argv[1], &end, 10);
    if (!end || *end != L'\0' || parsedPid == 0 || parsedPid > 0xFFFFFFFFu) {
        PrintError("invalid target pid");
        return 2;
    }
    const DWORD pid = static_cast<DWORD>(parsedPid);
    std::wstring dllPath;
    if (!GetAbsolutePath(argv[2], dllPath) || dllPath.empty()
        || GetFileAttributesW(dllPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
        PrintError("hook dll not found");
        return 3;
    }
    const bool callExport = argc == 4;
    const std::wstring exportName = callExport ? argv[3] : L"";
    if (callExport && exportName.empty()) {
        PrintError("invalid export name");
        return 2;
    }
    if (!IsStormworksProcess(pid)) {
        PrintError("target is not stormworks64.exe");
        return 4;
    }

    RemoteModule remoteModule{};
    bool alreadyLoaded = FindRemoteModule(pid, dllPath, remoteModule);
    if (!alreadyLoaded && !callExport) alreadyLoaded = IsLegacyHookLoaded(pid);
    if (alreadyLoaded && !callExport) {
        std::cout << "already loaded" << std::endl;
        return 0;
    }
    if (alreadyLoaded && callExport && remoteModule.base == 0) {
        PrintError("remote hook module not found");
        return 10;
    }

    HANDLE process = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION
        | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!process) {
        PrintError("access denied");
        return 5;
    }

    if (!alreadyLoaded) {
        SIZE_T bytes = (dllPath.size() + 1) * sizeof(wchar_t);
        void* remotePath = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!remotePath || !WriteProcessMemory(process, remotePath, dllPath.c_str(), bytes, nullptr)) {
            if (remotePath) VirtualFreeEx(process, remotePath, 0, MEM_RELEASE);
            CloseHandle(process);
            PrintError("remote allocation failed");
            return 6;
        }
        HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
        auto loadLibrary = kernel
            ? reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(kernel, "LoadLibraryW")) : nullptr;
        HANDLE thread = loadLibrary
            ? CreateRemoteThread(process, nullptr, 0, loadLibrary, remotePath, 0, nullptr) : nullptr;
        if (!thread) {
            VirtualFreeEx(process, remotePath, 0, MEM_RELEASE);
            CloseHandle(process);
            PrintError("remote thread creation failed");
            return 7;
        }
        DWORD loadResult = 0;
        bool completed = WaitForThread(thread, loadResult);
        CloseHandle(thread);
        if (!completed) {
            CloseHandle(process);
            PrintError("remote load wait failed");
            return 9;
        }
        VirtualFreeEx(process, remotePath, 0, MEM_RELEASE);
        if (loadResult == 0) {
            CloseHandle(process);
            PrintError("hook dll load failed");
            return 8;
        }
        if (callExport && !FindRemoteModule(pid, dllPath, remoteModule)) {
            CloseHandle(process);
            PrintError("remote hook module not found");
            return 10;
        }
    }

    if (!callExport) {
        CloseHandle(process);
        std::cout << "loaded" << std::endl;
        return 0;
    }

    uintptr_t exportRva = 0;
    if (!GetExportRva(dllPath, exportName, exportRva)) {
        CloseHandle(process);
        PrintError("hook export not found");
        return 11;
    }
    if (exportRva >= remoteModule.size || remoteModule.base > UINTPTR_MAX - exportRva) {
        CloseHandle(process);
        PrintError("hook export address is out of range");
        return 12;
    }
    auto remoteExport = reinterpret_cast<LPTHREAD_START_ROUTINE>(remoteModule.base + exportRva);
    HANDLE exportThread = CreateRemoteThread(process, nullptr, 0, remoteExport, nullptr, 0, nullptr);
    if (!exportThread) {
        CloseHandle(process);
        PrintError("hook export thread creation failed");
        return 13;
    }
    DWORD exportResult = 0;
    bool exportCompleted = WaitForThread(exportThread, exportResult);
    CloseHandle(exportThread);
    CloseHandle(process);
    if (!exportCompleted) {
        PrintError("hook export wait failed");
        return 14;
    }
    if (exportResult == 0) {
        PrintError("hook export call failed");
        return 15;
    }
    std::cout << "loaded and export called" << std::endl;
    return 0;
}
