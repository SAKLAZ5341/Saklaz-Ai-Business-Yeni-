/**
 * Tipli kripto hataları. Kriptografik doğrulama hataları hiçbir zaman "yeniden dene" ile
 * geçiştirilmez (ARCHITECTURE.md §11). Mesajlar bilerek ayrıntısızdır: saldırgana hangi
 * kontrolün başarısız olduğunu sızdırmamak için ayrıntı yalnızca `code` alanındadır.
 */
export type CryptoErrorCode =
  | "INVALID_KEY"
  | "INVALID_INPUT"
  | "DH_FAILED"
  | "DECRYPT_FAILED"
  | "SIGNATURE_INVALID"
  | "NONCE_EXHAUSTED"
  | "HANDSHAKE_STATE"
  | "EXPIRED";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CryptoError";
    this.code = code;
  }
}
