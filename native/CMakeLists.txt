cmake_minimum_required(VERSION 3.20)
project(WebMapOverlayNative LANGUAGES C CXX)

if(NOT WIN32)
  message(FATAL_ERROR "WebMapOverlay native components require Windows.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(NATIVE_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(MINHOOK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/vendor/minhook-1.3.4-src")
set(MINHOOK_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/minhook-1.3.4-include")
set(NATIVE_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/build/$<CONFIG>")

add_library(WebMapOverlayWriter SHARED writer/WebMapOverlayWriter.cpp)
target_include_directories(WebMapOverlayWriter PRIVATE ${NATIVE_INCLUDE_DIR})
target_compile_definitions(WebMapOverlayWriter PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlayWriter PROPERTIES
  OUTPUT_NAME "WebMapOverlayWriter"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

set(MINHOOK_SOURCES
  ${MINHOOK_ROOT}/buffer.c
  ${MINHOOK_ROOT}/hook.c
  ${MINHOOK_ROOT}/trampoline.c
  ${MINHOOK_ROOT}/hde/hde32.c
  ${MINHOOK_ROOT}/hde/hde64.c)
add_library(WebMapOverlayHook SHARED hook/WebMapOverlayHook.cpp ${MINHOOK_SOURCES})
target_include_directories(WebMapOverlayHook PRIVATE
  ${NATIVE_INCLUDE_DIR}
  ${MINHOOK_INCLUDE_DIR}
  ${MINHOOK_ROOT})
target_compile_definitions(WebMapOverlayHook PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(WebMapOverlayHook PRIVATE opengl32)
set_target_properties(WebMapOverlayHook PROPERTIES
  OUTPUT_NAME "WebMapOverlayHook"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_executable(WebMapOverlayInjector injector/WebMapOverlayInjector.cpp)
target_compile_definitions(WebMapOverlayInjector PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlayInjector PROPERTIES
  OUTPUT_NAME "WebMapOverlayInjector"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_library(WebMapOverlayLoadOnly SHARED load-only/WebMapOverlayLoadOnly.c)
target_compile_definitions(WebMapOverlayLoadOnly PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_compile_options(WebMapOverlayLoadOnly PRIVATE /GS-)
target_link_options(WebMapOverlayLoadOnly PRIVATE /NODEFAULTLIB /ENTRY:DllMain)
set_target_properties(WebMapOverlayLoadOnly PROPERTIES
  OUTPUT_NAME "WebMapOverlayLoadOnly"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_library(WebMapOverlayPassThrough SHARED pass-through/WebMapOverlayPassThrough.cpp ${MINHOOK_SOURCES})
target_include_directories(WebMapOverlayPassThrough PRIVATE
  ${MINHOOK_INCLUDE_DIR}
  ${MINHOOK_ROOT})
target_compile_definitions(WebMapOverlayPassThrough PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlayPassThrough PROPERTIES
  OUTPUT_NAME "WebMapOverlayPassThrough"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_library(WebMapOverlayStaticRect SHARED static-rect/WebMapOverlayStaticRect.cpp ${MINHOOK_SOURCES})
target_include_directories(WebMapOverlayStaticRect PRIVATE
  ${MINHOOK_INCLUDE_DIR}
  ${MINHOOK_ROOT})
target_compile_definitions(WebMapOverlayStaticRect PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlayStaticRect PROPERTIES
  OUTPUT_NAME "WebMapOverlayStaticRect"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_library(WebMapOverlaySharedFrameTest SHARED shared-frame-test/WebMapOverlaySharedFrameTest.cpp ${MINHOOK_SOURCES})
target_include_directories(WebMapOverlaySharedFrameTest PRIVATE
  ${NATIVE_INCLUDE_DIR}
  ${MINHOOK_INCLUDE_DIR}
  ${MINHOOK_ROOT})
target_compile_definitions(WebMapOverlaySharedFrameTest PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlaySharedFrameTest PROPERTIES
  OUTPUT_NAME "WebMapOverlaySharedFrameTest"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_library(WebMapOverlaySharedFrameDiagnostic SHARED shared-frame-diagnostic/WebMapOverlaySharedFrameDiagnostic.cpp ${MINHOOK_SOURCES})
target_include_directories(WebMapOverlaySharedFrameDiagnostic PRIVATE
  ${NATIVE_INCLUDE_DIR}
  ${MINHOOK_INCLUDE_DIR}
  ${MINHOOK_ROOT})
target_compile_definitions(WebMapOverlaySharedFrameDiagnostic PRIVATE WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
set_target_properties(WebMapOverlaySharedFrameDiagnostic PROPERTIES
  OUTPUT_NAME "WebMapOverlaySharedFrameDiagnostic"
  RUNTIME_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${NATIVE_OUTPUT_DIR}")

add_custom_target(WebMapOverlayNativeLicense ALL
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_SOURCE_DIR}/build/$<CONFIG>"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/vendor/MinHook-LICENSE.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/build/$<CONFIG>/MinHook-LICENSE.txt"
  VERBATIM)
add_dependencies(WebMapOverlayHook WebMapOverlayNativeLicense)
