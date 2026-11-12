import { sodium } from "./sodium.js";
import { assertLength, concat, utf8 } from "./bytes.js";
import { CryptoError } from "./errors.js";

export interface SigningKeyPair {
  /** Ed25519 açık anahtar (32 bayt). */
  publicKey: Uint8Array;
  /** Ed25519 gizli anahtar (libsodium biçimi, 64 bayt: tohum || açık anahtar). */
  secretKey: Uint8Array;
}

/**
 * İzin verilen imza alanları. Her imza bir alanla önek alır, böylece bir bağlamda
 * üretilmiş imza başka bir bağlamda geçerli sayılamaz (FAZ1-PLAN §4.2).
 */
export const SIGNATURE_DOMAINS = [
  "SAKLAZ-v1/msg",
  "SAKLAZ-v1/approval",
  "SAKLAZ-v1/pair",
  "SAKLAZ-v1/audit",
  "SAKLAZ-v1/key-rotate",
] as const;
export type SignatureDomain = (typeof SIGNATURE_DOMAINS)[number];

function framed(domain: SignatureDomain, message: Uint8Array): Uint8Array {
  if (!(SIGNATURE_DOMAINS as readonly string[]).includes(domain)) {
    throw new CryptoError("INVALID_INPUT", "Bilinmeyen imza alanı.");
  }
  return concat(utf8(domain), new Uint8Array([0]), message);
}

export function generateSigningKeyPair(): SigningKeyPair {
  const kp = sodium().crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Yalnızca test ve test vektörleri için: deterministik anahtar. Üretimde KULLANILMAZ. */
export function signingKeyPairFromSeed(seed: Uint8Array): SigningKeyPair {
  assertLength(seed, 32, "Ed25519 tohumu");
  const kp = sodium().crypto_sign_seed_keypair(seed);
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function sign(domain: SignatureDomain, message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  assertLength(secretKey, 64, "Ed25519 gizli anahtarı");
  return sodium().crypto_sign_detached(framed(domain, message), secretKey);
}

/** İmza geçerliyse true. Geçersiz uzunluktaki girdiler de false döner (istisna fırlatmaz). */
export function verify(
  domain: SignatureDomain,
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return sodium().crypto_sign_verify_detached(signature, framed(domain, message), publicKey);
  } catch {
    return false;
  }
}

/** Doğrulama başarısızsa SIGNATURE_INVALID fırlatır. */
export function assertValidSignature(
  domain: SignatureDomain,
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): void {
  if (!verify(domain, message, signature, publicKey)) {
    throw new CryptoError("SIGNATURE_INVALID");
  }
}
