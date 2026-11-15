/**
 * Anahtar koruyucu arayüzü (Sprint 3 A3; teknik tasarım §3).
 *
 * Bir KeyProtector, 32 baytlık anahtar şifreleme anahtarını (KEK) platformun anahtar koruma
 * mekanizmasıyla sarar. Windows'ta DPAPI (kullanıcı kapsamı); A4'te TPM eklenecek. Testlerde
 * yalnızca test klasöründeki sahte koruyucu kullanılır.
 *
 * Hata mesajları yalnızca kod içerir: anahtar, blob, yol içeriği veya sistem hata metni İÇERMEZ.
 */

export type ProtectorKind = "dpapi-user" | "test-fake";

/** Koruyucunun bağlı olduğu bağlam. Gizli DEĞİLDİR; dosyaya yalnızca özeti yazılır. */
export interface ProtectorBinding {
  /** Windows kullanıcı SID'i, ör. "S-1-5-21-…" */
  userSid: string;
  /** HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (küçük harf) */
  machineGuid: string;
}

export interface KeyProtector {
  readonly kind: ProtectorKind;
  binding(): ProtectorBinding;
  /** Hata → KeyProtectionError("PROTECT_FAILED") */
  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array;
  /** Başka kullanıcı, yanlış entropy, bozuk blob → KeyProtectionError("UNWRAP_FAILED") */
  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array;
}

export type KeyProtectionErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "PROTECT_FAILED"
  | "UNWRAP_FAILED"
  | "KEY_NOT_FOUND"
  | "KEY_EXISTS"
  | "KEY_FORMAT"
  | "KEY_VERSION"
  | "PROTECTOR_MISMATCH"
  | "BINDING_MISMATCH"
  | "KEY_INTEGRITY"
  | "WRITE_FAILED"
  | "INVALID_ARGUMENT";

export class KeyProtectionError extends Error {
  constructor(
    readonly code: KeyProtectionErrorCode,
    /** Windows hata numarası (varsa). */
    readonly win32Error?: number,
  ) {
    super(win32Error === undefined ? code : `${code} (win32=${String(win32Error)})`);
    this.name = "KeyProtectionError";
  }
}

/** Dosya başlığındaki koruyucu kimliği. */
export const PROTECTOR_IDS: Readonly<Record<ProtectorKind, number>> = { "dpapi-user": 1, "test-fake": 0xf0 };
