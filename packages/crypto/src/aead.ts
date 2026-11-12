import { sodium } from "./sodium.js";
import { assertLength } from "./bytes.js";
import { CryptoError } from "./errors.js";

/** ChaCha20-Poly1305 (IETF, 96 bit nonce) — Noise CipherState için. */
export function chachaEncrypt(key: Uint8Array, nonce12: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  assertLength(key, 32, "AEAD anahtarı");
  assertLength(nonce12, 12, "AEAD nonce");
  return sodium().crypto_aead_chacha20poly1305_ietf_encrypt(pt, ad, null, nonce12, key);
}

export function chachaDecrypt(key: Uint8Array, nonce12: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  assertLength(key, 32, "AEAD anahtarı");
  assertLength(nonce12, 12, "AEAD nonce");
  try {
    return sodium().crypto_aead_chacha20poly1305_ietf_decrypt(null, ct, ad, nonce12, key);
  } catch {
    throw new CryptoError("DECRYPT_FAILED");
  }
}

export const XNONCE_BYTES = 24;

/** XChaCha20-Poly1305 (192 bit rastgele nonce) — mühürlü zarf ve eşleştirme mesajları için. */
export function xchachaEncrypt(key: Uint8Array, nonce24: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  assertLength(key, 32, "AEAD anahtarı");
  assertLength(nonce24, XNONCE_BYTES, "XChaCha nonce");
  return sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(pt, ad, null, nonce24, key);
}

export function xchachaDecrypt(key: Uint8Array, nonce24: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  assertLength(key, 32, "AEAD anahtarı");
  assertLength(nonce24, XNONCE_BYTES, "XChaCha nonce");
  try {
    return sodium().crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce24, key);
  } catch {
    throw new CryptoError("DECRYPT_FAILED");
  }
}
