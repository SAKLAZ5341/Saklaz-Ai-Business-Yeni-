/**
 * Eşleştirme kriptografisi (SECURITY.md §4, FAZ1-PLAN §3).
 *
 * Eşleştirme sırrı S yalnızca Windows ekranındaki QR'da bulunur; relay'e hiç gönderilmez.
 * S'den türetilen anahtarlarla şifrelenen eşleştirme mesajlarını relay ne okuyabilir ne de
 * değiştirebilir. Son güvence olarak iki ekranda aynı 6 haneli SAS kullanıcıya gösterilir.
 */
import { concat, utf8 } from "./bytes.js";
import { assertLength } from "./bytes.js";
import { randomBytes } from "./bytes.js";
import { XNONCE_BYTES, xchachaDecrypt, xchachaEncrypt } from "./aead.js";
import { hkdf, taggedHash } from "./hash.js";

export const PAIRING_SECRET_BYTES = 32;

export function generatePairingSecret(): Uint8Array {
  return randomBytes(PAIRING_SECRET_BYTES);
}

export type PairingStage = "pair-req" | "pair-ok";

export function pairingKey(secret: Uint8Array, stage: PairingStage, sessionId: string): Uint8Array {
  assertLength(secret, PAIRING_SECRET_BYTES, "Eşleştirme sırrı");
  return hkdf(secret, utf8(`session:${sessionId}`), `SAKLAZ-v1/${stage}`, 32);
}

export interface PairingBox {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function sealPairingMessage(
  secret: Uint8Array,
  stage: PairingStage,
  sessionId: string,
  plaintext: Uint8Array,
): PairingBox {
  const nonce = randomBytes(XNONCE_BYTES);
  const ad = utf8(`SAKLAZ-v1/${stage}/${sessionId}`);
  return { nonce, ciphertext: xchachaEncrypt(pairingKey(secret, stage, sessionId), nonce, ad, plaintext) };
}

export function openPairingMessage(
  secret: Uint8Array,
  stage: PairingStage,
  sessionId: string,
  box: PairingBox,
): Uint8Array {
  const ad = utf8(`SAKLAZ-v1/${stage}/${sessionId}`);
  return xchachaDecrypt(pairingKey(secret, stage, sessionId), box.nonce, ad, box.ciphertext);
}

export interface SasInput {
  secret: Uint8Array;
  agentSignPub: Uint8Array;
  agentDhPub: Uint8Array;
  phoneSignPub: Uint8Array;
  phoneDhPub: Uint8Array;
}

/**
 * 6 haneli Kısa Doğrulama Dizisi. Her iki taraf aynı girdilerle aynı diziyi hesaplar.
 * 32 bitlik bir değerin 10^6 modu alınır; ortaya çıkan yanlılık (< 2^-12) pratikte önemsizdir.
 * Bu dizi, relay ortadaki adam olsa bile yalnızca 10^-6 olasılıkla tutar; SAS'ın görevi QR'ın
 * doğru cihazda okunduğunu ve anahtarların değiştirilmediğini kullanıcıya teyit ettirmektir.
 */
export function computeSas(i: SasInput): string {
  assertLength(i.agentSignPub, 32, "Ajan imza anahtarı");
  assertLength(i.agentDhPub, 32, "Ajan DH anahtarı");
  assertLength(i.phoneSignPub, 32, "Telefon imza anahtarı");
  assertLength(i.phoneDhPub, 32, "Telefon DH anahtarı");
  assertLength(i.secret, PAIRING_SECRET_BYTES, "Eşleştirme sırrı");
  const digest = taggedHash(
    "SAKLAZ-SAS-v1",
    concat(i.secret, i.agentSignPub, i.agentDhPub, i.phoneSignPub, i.phoneDhPub),
    32,
  );
  const v = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false);
  return String(v % 1_000_000).padStart(6, "0");
}
