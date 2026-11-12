import { sodium } from "./sodium.js";
import { concat, utf8 } from "./bytes.js";
import { CryptoError } from "./errors.js";

/** BLAKE2b çıktı uzunluğu (Noise HASHLEN) ve blok uzunluğu (BLOCKLEN). */
export const HASHLEN = 64;
const BLOCKLEN = 128;

export function blake2b(data: Uint8Array, outLen: number = HASHLEN): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 16 || outLen > 64) {
    throw new CryptoError("INVALID_INPUT", "BLAKE2b çıktı uzunluğu 16–64 olmalı.");
  }
  return sodium().crypto_generichash(outLen, data, null);
}

/** Alan ayrımlı özet: H(etiket || 0x00 || veri). Farklı bağlamlardaki özetler çakışamaz. */
export function taggedHash(tag: string, data: Uint8Array, outLen: number = 32): Uint8Array {
  return blake2b(concat(utf8(tag), new Uint8Array([0]), data), outLen);
}

/** RFC 2104 HMAC, BLAKE2b ile (Noise spesifikasyonu §4.3 ile aynı yapı). */
export function hmacBlake2b(key: Uint8Array, data: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > BLOCKLEN) k = blake2b(k);
  const block = new Uint8Array(BLOCKLEN);
  block.set(k);
  const ipad = new Uint8Array(BLOCKLEN);
  const opad = new Uint8Array(BLOCKLEN);
  for (let i = 0; i < BLOCKLEN; i++) {
    const b = block[i] ?? 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const inner = blake2b(concat(ipad, data));
  return blake2b(concat(opad, inner));
}

/**
 * Noise HKDF (Noise §4.3): HKDF(chainingKey, ikm, numOutputs) → 2 veya 3 adet HASHLEN baytlık çıktı.
 */
export function noiseHkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
  const tempKey = hmacBlake2b(ck, ikm);
  const out1 = hmacBlake2b(tempKey, new Uint8Array([1]));
  const out2 = hmacBlake2b(tempKey, concat(out1, new Uint8Array([2])));
  if (n === 2) return [out1, out2];
  const out3 = hmacBlake2b(tempKey, concat(out2, new Uint8Array([3])));
  return [out1, out2, out3];
}

/**
 * Genel amaçlı HKDF (RFC 5869, HMAC-BLAKE2b). Mühürlü zarf ve eşleştirme anahtarları için.
 * `info` her kullanım için benzersiz bir bağlam etiketi olmalıdır.
 */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 255 * HASHLEN) {
    throw new CryptoError("INVALID_INPUT", "HKDF çıktı uzunluğu geçersiz.");
  }
  const prk = hmacBlake2b(salt.length ? salt : new Uint8Array(HASHLEN), ikm);
  const infoBytes = utf8(info);
  const out = new Uint8Array(length);
  let prev: Uint8Array = new Uint8Array(0);
  let off = 0;
  for (let i = 1; off < length; i++) {
    prev = hmacBlake2b(prk, concat(prev, infoBytes, new Uint8Array([i])));
    const take = Math.min(prev.length, length - off);
    out.set(prev.subarray(0, take), off);
    off += take;
  }
  return out;
}
