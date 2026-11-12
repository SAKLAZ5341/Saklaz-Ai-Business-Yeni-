import { sodium } from "./sodium.js";
import { assertLength } from "./bytes.js";
import { CryptoError } from "./errors.js";

export interface DhKeyPair {
  /** X25519 açık anahtar (32 bayt). */
  publicKey: Uint8Array;
  /** X25519 gizli anahtar (32 bayt). */
  secretKey: Uint8Array;
}

export function generateDhKeyPair(): DhKeyPair {
  const s = sodium();
  const secretKey = s.randombytes_buf(32);
  return { publicKey: s.crypto_scalarmult_base(secretKey), secretKey };
}

/** Bilinen gizli anahtardan anahtar çifti (test vektörleri ve depodan yükleme için). */
export function dhKeyPairFromSecret(secretKey: Uint8Array): DhKeyPair {
  assertLength(secretKey, 32, "X25519 gizli anahtarı");
  return { publicKey: sodium().crypto_scalarmult_base(secretKey), secretKey };
}

/**
 * X25519. Düşük dereceli (low-order) noktalar sıfır çıktı üretir; libsodium bu durumda hata
 * verir ve biz bunu DH_FAILED olarak raporlarız. Bu, karşı tarafın anahtar katkısını
 * sıfırlamaya çalışan saldırıları engeller.
 */
export function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertLength(secretKey, 32, "X25519 gizli anahtarı");
  assertLength(publicKey, 32, "X25519 açık anahtarı");
  let out: Uint8Array;
  try {
    out = sodium().crypto_scalarmult(secretKey, publicKey);
  } catch {
    throw new CryptoError("DH_FAILED");
  }
  let acc = 0;
  for (const b of out) acc |= b;
  if (acc === 0) throw new CryptoError("DH_FAILED");
  return out;
}
