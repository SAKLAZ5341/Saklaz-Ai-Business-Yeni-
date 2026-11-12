/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 sn, 6 hane). Telefon kimlik doğrulayıcı uygulamalarıyla uyumludur.
 * RFC 6238 Ek B test vektörleriyle doğrulanır (test/totp.test.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function generateTotpSecret(): Uint8Array {
  return randomBytes(20);
}

export function hotp(secret: Uint8Array, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 0x0f;
  const bin =
    (((h[off] ?? 0) & 0x7f) << 24) | ((h[off + 1] ?? 0) << 16) | ((h[off + 2] ?? 0) << 8) | (h[off + 3] ?? 0);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: Uint8Array, nowMs: number, digits = 6): string {
  return hotp(secret, BigInt(Math.floor(nowMs / 1000 / 30)), digits);
}

/** ±1 zaman adımı toleransla doğrular (saat kayması). Karşılaştırma sabit zamanlıdır. */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = BigInt(Math.floor(nowMs / 1000 / 30));
  let ok = false;
  for (const d of [-1n, 0n, 1n]) {
    const expected = Buffer.from(hotp(secret, step + d));
    if (timingSafeEqual(expected, Buffer.from(code))) ok = true;
  }
  return ok;
}

export function otpauthUri(secret: Uint8Array, account: string, issuer = "SAKLAZ AI"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
