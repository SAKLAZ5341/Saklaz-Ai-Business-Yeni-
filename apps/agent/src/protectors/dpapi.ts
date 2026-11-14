/**
 * Windows DPAPI koruyucusu (kullanıcı kapsamı). Sprint 3 A3.
 *
 * KEK, geçerli Windows kullanıcısının DPAPI ana anahtarıyla sarılır: aynı makinedeki başka bir
 * kullanıcı veya dosyayı başka bir makineye kopyalayan biri onu çözemez. Aynı kullanıcı adına
 * çalışan kötü amaçlı yazılıma karşı koruma SAĞLAMAZ (teknik tasarım R-A3-1).
 *
 * Yerel modül yüklenemezse (Windows değil veya derlenmemiş) koruyucu OLUŞTURULMAZ; güvensiz bir
 * yönteme geri düşülmez.
 */
import { KeyProtectError, loadNative, type NativeKeyProtect } from "@saklaz/win-keyprotect";
import { KeyProtectionError, type KeyProtector, type ProtectorBinding } from "./types.js";

function translate(e: unknown, fallback: "PROTECT_FAILED" | "UNWRAP_FAILED"): KeyProtectionError {
  if (e instanceof KeyProtectError) {
    if (e.code === "UNSUPPORTED_PLATFORM" || e.code === "NATIVE_MODULE_MISSING") return new KeyProtectionError("UNSUPPORTED_PLATFORM");
    if (e.code === "INVALID_ARGUMENT") return new KeyProtectionError("INVALID_ARGUMENT");
    return new KeyProtectionError(fallback, e.win32Error);
  }
  return new KeyProtectionError(fallback);
}

export class DpapiUserProtector implements KeyProtector {
  readonly kind = "dpapi-user" as const;
  private readonly native: NativeKeyProtect;
  private bound: ProtectorBinding | undefined;

  /** @param native test için; verilmezse gerçek yerel modül yüklenir. */
  constructor(native?: NativeKeyProtect) {
    try {
      this.native = native ?? loadNative();
    } catch (e) {
      throw translate(e, "PROTECT_FAILED");
    }
  }

  binding(): ProtectorBinding {
    if (!this.bound) {
      try {
        this.bound = { userSid: this.native.userSid(), machineGuid: this.native.machineGuid().toLowerCase() };
      } catch (e) {
        throw translate(e, "PROTECT_FAILED");
      }
    }
    return this.bound;
  }

  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array {
    try {
      return this.native.protect(kek, entropy);
    } catch (e) {
      throw translate(e, "PROTECT_FAILED");
    }
  }

  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array {
    try {
      return this.native.unprotect(blob, entropy);
    } catch (e) {
      throw translate(e, "UNWRAP_FAILED");
    }
  }
}
