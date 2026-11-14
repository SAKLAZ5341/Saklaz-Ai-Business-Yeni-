/*
 * SAKLAZ AI — @saklaz/win-keyprotect yerel modülü (Sprint 3 A3).
 *
 * Yalnızca Windows'un kendi kütüphanelerini kullanır: crypt32 (DPAPI), advapi32 (SID, kayıt
 * defteri okuma). Yönetici yetkisi, ağ erişimi, kayıt defterine yazma veya özel ayrıcalık YOKTUR.
 *
 * Dışa aktarılanlar:
 *   protect(data: Uint8Array, entropy: Uint8Array): Buffer      CryptProtectData (kullanıcı kapsamı)
 *   unprotect(blob: Uint8Array, entropy: Uint8Array): Buffer    CryptUnprotectData
 *   userSid(): string                                           geçerli sürecin kullanıcı SID'i
 *   machineGuid(): string                                       HKLM\...\Cryptography\MachineGuid
 *
 * Güvenlik kuralları:
 *   - CRYPTPROTECT_LOCAL_MACHINE KULLANILMAZ (makinedeki her kullanıcının açabileceği koruma yasak).
 *   - CRYPTPROTECT_UI_FORBIDDEN her çağrıda: hiçbir zaman kullanıcıya iletişim kutusu açılmaz.
 *   - Çözülen düz metin JS tamponuna kopyalandıktan hemen sonra SecureZeroMemory ile silinir.
 *   - Hata mesajları yalnızca hata kodunu ve Win32 hata numarasını içerir; veri İÇERMEZ.
 */
#define WIN32_LEAN_AND_MEAN
#define NAPI_VERSION 8
#include <windows.h>
#include <wincrypt.h>
#include <sddl.h>
#include <stdio.h>
#include <node_api.h>

#define MAX_DATA_BYTES (64u * 1024u)
#define MAX_ENTROPY_BYTES 1024u

/* Hata kodu ("code" özelliği) ve Win32 hata numarasıyla JS hatası fırlatır. */
static void throw_win32(napi_env env, const char *code, DWORD err) {
  char msg[96];
  sprintf_s(msg, sizeof(msg), "%s (win32=%lu)", code, (unsigned long)err);
  napi_throw_error(env, code, msg);
}

/* Bağımsız değişken bir Uint8Array (veya Buffer) olmalı; uzunluk sınırları denetlenir. */
static int get_bytes(napi_env env, napi_value v, BYTE **data, DWORD *len, size_t max, int allow_empty) {
  bool is_ta = false;
  napi_typedarray_type type;
  size_t length = 0;
  void *ptr = NULL;
  napi_value ab;
  size_t offset = 0;
  if (napi_is_typedarray(env, v, &is_ta) != napi_ok || !is_ta) return 0;
  if (napi_get_typedarray_info(env, v, &type, &length, &ptr, &ab, &offset) != napi_ok) return 0;
  if (type != napi_uint8_array) return 0;
  if (length > max) return 0;
  if (length == 0 && !allow_empty) return 0;
  *data = (BYTE *)ptr;
  *len = (DWORD)length;
  return 1;
}

static int get_two_args(napi_env env, napi_callback_info info, napi_value argv[2]) {
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return 0;
  return argc == 2;
}

/* DATA_BLOB çıktısını Buffer'a kopyalar, bellekteki kopyayı siler ve serbest bırakır. */
static napi_value blob_to_buffer(napi_env env, DATA_BLOB *out) {
  napi_value result = NULL;
  void *copy = NULL;
  napi_status st = napi_create_buffer_copy(env, out->cbData, out->pbData, &copy, &result);
  SecureZeroMemory(out->pbData, out->cbData);
  LocalFree(out->pbData);
  out->pbData = NULL;
  out->cbData = 0;
  if (st != napi_ok) {
    napi_throw_error(env, "INTERNAL", "INTERNAL");
    return NULL;
  }
  return result;
}

static napi_value Protect(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  DATA_BLOB in, ent, out;
  if (!get_two_args(env, info, argv) ||
      !get_bytes(env, argv[0], &in.pbData, &in.cbData, MAX_DATA_BYTES, 0) ||
      !get_bytes(env, argv[1], &ent.pbData, &ent.cbData, MAX_ENTROPY_BYTES, 1)) {
    napi_throw_type_error(env, "INVALID_ARGUMENT", "INVALID_ARGUMENT");
    return NULL;
  }
  out.pbData = NULL;
  out.cbData = 0;
  if (!CryptProtectData(&in, NULL, ent.cbData ? &ent : NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
    throw_win32(env, "PROTECT_FAILED", GetLastError());
    return NULL;
  }
  return blob_to_buffer(env, &out);
}

static napi_value Unprotect(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  DATA_BLOB in, ent, out;
  if (!get_two_args(env, info, argv) ||
      !get_bytes(env, argv[0], &in.pbData, &in.cbData, MAX_DATA_BYTES, 0) ||
      !get_bytes(env, argv[1], &ent.pbData, &ent.cbData, MAX_ENTROPY_BYTES, 1)) {
    napi_throw_type_error(env, "INVALID_ARGUMENT", "INVALID_ARGUMENT");
    return NULL;
  }
  out.pbData = NULL;
  out.cbData = 0;
  if (!CryptUnprotectData(&in, NULL, ent.cbData ? &ent : NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
    throw_win32(env, "UNPROTECT_FAILED", GetLastError());
    return NULL;
  }
  return blob_to_buffer(env, &out);
}

static napi_value UserSid(napi_env env, napi_callback_info info) {
  HANDLE token = NULL;
  DWORD len = 0;
  BYTE *buf = NULL;
  LPWSTR sid = NULL;
  napi_value result = NULL;
  (void)info;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    throw_win32(env, "SYSTEM_QUERY_FAILED", GetLastError());
    return NULL;
  }
  GetTokenInformation(token, TokenUser, NULL, 0, &len);
  buf = (BYTE *)LocalAlloc(LPTR, len);
  if (buf == NULL || !GetTokenInformation(token, TokenUser, buf, len, &len) ||
      !ConvertSidToStringSidW(((TOKEN_USER *)buf)->User.Sid, &sid)) {
    DWORD err = GetLastError();
    if (buf) LocalFree(buf);
    CloseHandle(token);
    throw_win32(env, "SYSTEM_QUERY_FAILED", err);
    return NULL;
  }
  napi_create_string_utf16(env, (const char16_t *)sid, NAPI_AUTO_LENGTH, &result);
  LocalFree(sid);
  LocalFree(buf);
  CloseHandle(token);
  return result;
}

static napi_value MachineGuid(napi_env env, napi_callback_info info) {
  WCHAR value[64];
  DWORD size = sizeof(value);
  napi_value result = NULL;
  LSTATUS st;
  (void)info;
  st = RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Cryptography", L"MachineGuid",
                    RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, NULL, value, &size);
  if (st != ERROR_SUCCESS) {
    throw_win32(env, "SYSTEM_QUERY_FAILED", (DWORD)st);
    return NULL;
  }
  napi_create_string_utf16(env, (const char16_t *)value, NAPI_AUTO_LENGTH, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"protect", NULL, Protect, NULL, NULL, NULL, napi_enumerable, NULL},
      {"unprotect", NULL, Unprotect, NULL, NULL, NULL, napi_enumerable, NULL},
      {"userSid", NULL, UserSid, NULL, NULL, NULL, napi_enumerable, NULL},
      {"machineGuid", NULL, MachineGuid, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
