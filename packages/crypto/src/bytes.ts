import { sodium } from "./sodium.js";
import { CryptoError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Sabit zamanlı karşılaştırma (uzunluk farklıysa hemen false; uzunluk gizli değildir). */
export function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return sodium().memcmp(a, b);
}

/** Gizli bayt dizisini bellekte sıfırlar (en iyi çaba; JS çöp toplayıcısı kopyaları garanti edemez). */
export function wipe(b: Uint8Array): void {
  sodium().memzero(b);
}

/** base64url, dolgusuz — JSON içinde taşınan tüm ikili alanlar için tek biçim. */
export function toB64(b: Uint8Array): string {
  const s = sodium();
  return s.to_base64(b, s.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new CryptoError("INVALID_INPUT", "Geçersiz base64url.");
  const so = sodium();
  try {
    return so.from_base64(s, so.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new CryptoError("INVALID_INPUT", "Geçersiz base64url.");
  }
}

export function toHex(b: Uint8Array): string {
  return sodium().to_hex(b);
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new CryptoError("INVALID_INPUT", "Geçersiz hex.");
  return sodium().from_hex(s);
}

export function randomBytes(n: number): Uint8Array {
  return sodium().randombytes_buf(n);
}

export function assertLength(b: Uint8Array, n: number, what: string): void {
  if (!(b instanceof Uint8Array) || b.length !== n) {
    throw new CryptoError("INVALID_KEY", `${what}: ${n} bayt bekleniyordu.`);
  }
}
