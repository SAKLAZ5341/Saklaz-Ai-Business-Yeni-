/**
 * @saklaz/win-keyprotect — Windows DPAPI (kullanıcı kapsamı) için ince sarmalayıcı. Sprint 3 A3.
 *
 * Yerel modül (native/keyprotect.c) yalnızca Windows'ta derlenir. Diğer platformlarda bu paket
 * İÇE AKTARILABİLİR (tip denetimi ve testler için), ama her çağrı UNSUPPORTED_PLATFORM hatası verir.
 * Hiçbir durumda güvensiz bir yönteme geri düşülmez.
 *
 * Hata mesajları yalnızca kod ve Win32 hata numarası içerir; veri, anahtar veya blob İÇERMEZ.
 */
import { createRequire } from "node:module";

export const MAX_DATA_BYTES = 64 * 1024;
export const MAX_ENTROPY_BYTES = 1024;

export type KeyProtectErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "NATIVE_MODULE_MISSING"
  | "INVALID_ARGUMENT"
  | "PROTECT_FAILED"
  | "UNPROTECT_FAILED"
  | "SYSTEM_QUERY_FAILED"
  | "INTERNAL";

export class KeyProtectError extends Error {
  constructor(
    readonly code: KeyProtectErrorCode,
    /** Windows hata numarası (varsa). Veri içermez. */
    readonly win32Error?: number,
  ) {
    super(win32Error === undefined ? code : `${code} (win32=${String(win32Error)})`);
    this.name = "KeyProtectError";
  }
}

/** Yerel modülün arayüzü. Testlerde aynı arayüzle sahte bir uygulama verilebilir. */
export interface NativeKeyProtect {
  protect(data: Uint8Array, entropy: Uint8Array): Uint8Array;
  unprotect(blob: Uint8Array, entropy: Uint8Array): Uint8Array;
  userSid(): string;
  machineGuid(): string;
}

const KNOWN: readonly string[] = ["INVALID_ARGUMENT", "PROTECT_FAILED", "UNPROTECT_FAILED", "SYSTEM_QUERY_FAILED", "INTERNAL"];

/** Yerel hatayı KeyProtectError'a çevirir. Bilinmeyen hatanın mesajı İLETİLMEZ. */
function mapError(e: unknown): KeyProtectError {
  const x = e as { code?: unknown; message?: unknown };
  const code = typeof x.code === "string" && KNOWN.includes(x.code) ? (x.code as KeyProtectErrorCode) : "INTERNAL";
  const m = typeof x.message === "string" ? /win32=(\d+)/.exec(x.message) : null;
  return new KeyProtectError(code, m?.[1] === undefined ? undefined : Number(m[1]));
}

function checkBytes(v: Uint8Array, max: number, allowEmpty: boolean): void {
  if (!(v instanceof Uint8Array) || v.length > max || (!allowEmpty && v.length === 0)) {
    throw new KeyProtectError("INVALID_ARGUMENT");
  }
}

let cached: NativeKeyProtect | undefined;

/**
 * Yerel modülü yükler. Windows değilse UNSUPPORTED_PLATFORM; derlenmemişse NATIVE_MODULE_MISSING.
 * @param platform test için
 */
export function loadNative(platform: NodeJS.Platform = process.platform): NativeKeyProtect {
  if (platform !== "win32") throw new KeyProtectError("UNSUPPORTED_PLATFORM");
  if (cached) return cached;
  let raw: NativeKeyProtect;
  try {
    raw = createRequire(import.meta.url)("../native/build/Release/keyprotect.node") as NativeKeyProtect;
  } catch {
    throw new KeyProtectError("NATIVE_MODULE_MISSING");
  }
  cached = wrapNative(raw);
  return cached;
}

/** Ham yerel modülü girdi denetimi ve hata eşlemesiyle sarar (testlerde sahte modülle de kullanılır). */
export function wrapNative(raw: NativeKeyProtect): NativeKeyProtect {
  const call = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw mapError(e);
    }
  };
  return {
    protect(data, entropy) {
      checkBytes(data, MAX_DATA_BYTES, false);
      checkBytes(entropy, MAX_ENTROPY_BYTES, true);
      return new Uint8Array(call(() => raw.protect(data, entropy)));
    },
    unprotect(blob, entropy) {
      checkBytes(blob, MAX_DATA_BYTES, false);
      checkBytes(entropy, MAX_ENTROPY_BYTES, true);
      return new Uint8Array(call(() => raw.unprotect(blob, entropy)));
    },
    userSid: () => call(() => raw.userSid()),
    machineGuid: () => call(() => raw.machineGuid()).toLowerCase(),
  };
}

/** Bu platformda yerel modül kullanılabilir mi? (Durum ekranı için; güvenlik kararı değildir.) */
export function isAvailable(platform: NodeJS.Platform = process.platform): boolean {
  try {
    loadNative(platform);
    return true;
  } catch {
    return false;
  }
}
