/**
 * Mühürlü zarf: alıcı çevrimdışıyken (Noise oturumu kurulamazken) tek yönlü mesaj.
 * FAZ1-PLAN §5.3, ADR-0007.
 *
 *   eph = X25519 geçici anahtar
 *   ikm = DH(eph, R) || DH(S, R)          (S: gönderenin statik DH anahtarı)
 *   k   = HKDF(ikm, salt = eph.pub || S.pub || R.pub, "SAKLAZ-v1/sealed")
 *   ct  = XChaCha20-Poly1305(k, nonce, ad = bağlam)
 *
 * DH(S, R) bileşeni sayesinde alıcı, mesajın eşleştirilmiş gönderenden geldiğini anahtar
 * düzeyinde de doğrular. İçerikteki Ed25519 imzası ayrıca kalıcı ve denetlenebilir kanıttır.
 *
 * Bilinen sınır: alıcının statik anahtarı ele geçirilirse, o anahtara mühürlenmiş geçmiş
 * mesajlar çözülebilir (sınırlı ileri gizlilik). Bu, ADR-0007 ile kabul edilmiştir; bu yol
 * yalnızca kuyruğa alınan mesajlar içindir, canlı trafik Noise_KK kullanır.
 */
import { concat } from "./bytes.js";
import { randomBytes } from "./bytes.js";
import { XNONCE_BYTES, xchachaDecrypt, xchachaEncrypt } from "./aead.js";
import { dh, generateDhKeyPair, type DhKeyPair } from "./dh.js";
import { hkdf } from "./hash.js";
import { CryptoError } from "./errors.js";

export interface SealedBox {
  ephemeralPublicKey: Uint8Array; // 32
  nonce: Uint8Array; // 24
  ciphertext: Uint8Array;
}

const INFO = "SAKLAZ-v1/sealed";

function deriveKey(
  ephPub: Uint8Array,
  senderPub: Uint8Array,
  recipientPub: Uint8Array,
  dh1: Uint8Array,
  dh2: Uint8Array,
): Uint8Array {
  return hkdf(concat(dh1, dh2), concat(ephPub, senderPub, recipientPub), INFO, 32);
}

/**
 * @param context Şifrelenmeyen ama doğrulanan bağlam (ör. zarf kimliği, gönderen ve alıcı
 *   cihaz kimlikleri). Alıcı aynı bağlamı vermezse çözme başarısız olur.
 */
export function seal(
  sender: DhKeyPair,
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  context: Uint8Array,
  testOnly?: { ephemeral: DhKeyPair; nonce: Uint8Array },
): SealedBox {
  const eph = testOnly?.ephemeral ?? generateDhKeyPair();
  const nonce = testOnly?.nonce ?? randomBytes(XNONCE_BYTES);
  const key = deriveKey(
    eph.publicKey,
    sender.publicKey,
    recipientPublicKey,
    dh(eph.secretKey, recipientPublicKey),
    dh(sender.secretKey, recipientPublicKey),
  );
  const ad = concat(eph.publicKey, sender.publicKey, recipientPublicKey, context);
  const ciphertext = xchachaEncrypt(key, nonce, ad, plaintext);
  return { ephemeralPublicKey: eph.publicKey, nonce, ciphertext };
}

export function open(
  recipient: DhKeyPair,
  senderPublicKey: Uint8Array,
  box: SealedBox,
  context: Uint8Array,
): Uint8Array {
  if (box.ephemeralPublicKey.length !== 32 || box.nonce.length !== XNONCE_BYTES) {
    throw new CryptoError("INVALID_INPUT", "Geçersiz mühürlü zarf.");
  }
  const key = deriveKey(
    box.ephemeralPublicKey,
    senderPublicKey,
    recipient.publicKey,
    dh(recipient.secretKey, box.ephemeralPublicKey),
    dh(recipient.secretKey, senderPublicKey),
  );
  const ad = concat(box.ephemeralPublicKey, senderPublicKey, recipient.publicKey, context);
  return xchachaDecrypt(key, box.nonce, ad, box.ciphertext);
}
