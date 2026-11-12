/**
 * Noise_KK_25519_ChaChaPoly_BLAKE2b
 *
 * Noise Protocol Framework (rev. 34) uyarınca, yalnızca KK deseni için yazılmış küçük ve
 * denetlenebilir bir uygulama. Tüm primitifler libsodium'dandır; burada yalnızca Noise
 * durum makinesi bulunur. Doğruluk, resmî cacophony test vektörleriyle doğrulanır
 * (test/noise.test.ts).
 *
 * KK:
 *   -> s
 *   <- s
 *   ...
 *   -> e, es, ss
 *   <- e, ee, se
 *
 * Neden KK: Taraflar birbirinin statik anahtarını eşleştirmede (QR + SAS) zaten öğrenmiştir.
 * Bu sayede relay sunucusu hiçbir aşamada sahte bir taraf olarak araya giremez ve her oturum
 * geçici anahtarlarla ileri gizlilik sağlar (ADR-0002, ADR-0008).
 */
import { concat, utf8, wipe } from "./bytes.js";
import { chachaDecrypt, chachaEncrypt } from "./aead.js";
import { dh, generateDhKeyPair, type DhKeyPair } from "./dh.js";
import { blake2b, HASHLEN, noiseHkdf } from "./hash.js";
import { CryptoError } from "./errors.js";

export const NOISE_PROTOCOL_NAME = "Noise_KK_25519_ChaChaPoly_BLAKE2b";
export const NOISE_MAX_MESSAGE = 65535;
const DHLEN = 32;
const TAGLEN = 16;
const MAX_NONCE = 0xffffffffffffffffn; // 2^64-1: Noise tarafından ayrılmıştır, kullanılmaz.

function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

/** Noise CipherState (§5.1). */
export class CipherState {
  private k: Uint8Array | undefined;
  private n = 0n;

  initializeKey(key: Uint8Array | undefined): void {
    if (this.k) wipe(this.k);
    this.k = key ? key.slice() : undefined;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== undefined;
  }

  /** Test ve gözlemlenebilirlik için: şu ana kadar kullanılan nonce sayısı. */
  get nonce(): bigint {
    return this.n;
  }

  encryptWithAd(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (!this.k) return pt.slice();
    if (this.n >= MAX_NONCE) throw new CryptoError("NONCE_EXHAUSTED");
    const ct = chachaEncrypt(this.k, nonceBytes(this.n), ad, pt);
    this.n += 1n;
    return ct;
  }

  /** Kimlik doğrulama başarısızsa nonce ARTMAZ (Noise §5.1). */
  decryptWithAd(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.k) return ct.slice();
    if (this.n >= MAX_NONCE) throw new CryptoError("NONCE_EXHAUSTED");
    const pt = chachaDecrypt(this.k, nonceBytes(this.n), ad, ct);
    this.n += 1n;
    return pt;
  }

  /** Noise §4.2 REKEY: k = ENCRYPT(k, 2^64-1, boş, 32 sıfır)[0:32]. Nonce sıfırlanmaz. */
  rekey(): void {
    if (!this.k) throw new CryptoError("HANDSHAKE_STATE", "Anahtarsız CipherState yenilenemez.");
    const full = chachaEncrypt(this.k, nonceBytes(MAX_NONCE), new Uint8Array(0), new Uint8Array(32));
    const next = full.slice(0, 32);
    wipe(this.k);
    this.k = next;
  }

  destroy(): void {
    if (this.k) wipe(this.k);
    this.k = undefined;
  }
}

/** Noise SymmetricState (§5.2). */
class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  readonly cipher = new CipherState();

  constructor(protocolName: string) {
    // Protokol adımız sabit ve HASHLEN'den kısa; bu nedenle Noise §5.2'deki "uzun ad → özet"
    // dalına ihtiyaç yoktur. Ad değişirse bu kontrol hatayı erkenden yakalar.
    const name = utf8(protocolName);
    if (name.length > HASHLEN) throw new CryptoError("INVALID_INPUT", "Protokol adı çok uzun.");
    this.h = new Uint8Array(HASHLEN);
    this.h.set(name);
    this.ck = this.h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.ck, ikm, 2) as [Uint8Array, Uint8Array];
    wipe(this.ck);
    this.ck = ck;
    this.cipher.initializeKey(tempK.subarray(0, 32));
    wipe(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = blake2b(concat(this.h, data));
  }

  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, pt);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ct);
    this.mixHash(ct);
    return pt;
  }

  handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.ck, new Uint8Array(0), 2) as [Uint8Array, Uint8Array];
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1.subarray(0, 32));
    c2.initializeKey(k2.subarray(0, 32));
    wipe(k1);
    wipe(k2);
    wipe(this.ck);
    this.cipher.destroy();
    return [c1, c2];
  }
}

export interface NoiseKKOptions {
  initiator: boolean;
  /** Oturumu bağlama bağlayan önsöz (ör. "SAKLAZ-v1" || agentId || phoneId || proto). */
  prologue: Uint8Array;
  /** Yerel statik X25519 anahtar çifti. */
  s: DhKeyPair;
  /** Karşı tarafın eşleştirmede sabitlenmiş statik X25519 açık anahtarı. */
  rs: Uint8Array;
  /**
   * YALNIZCA TEST VEKTÖRLERİ İÇİN: sabit geçici anahtar. Üretim kodunda verilmemelidir;
   * verilmezse her oturumda yeni rastgele geçici anahtar üretilir.
   */
  testOnlyEphemeral?: DhKeyPair;
}

/** Tamamlanmış el sıkışmadan çıkan taşıma oturumu. */
export interface NoiseTransport {
  send: CipherState;
  recv: CipherState;
  /** Kanal bağlama (channel binding) için el sıkışma özeti. */
  handshakeHash: Uint8Array;
}

/** Noise HandshakeState — yalnızca KK deseni (§5.3, §7.5). */
export class NoiseKK {
  private readonly ss: SymmetricState;
  private readonly initiator: boolean;
  private readonly s: DhKeyPair;
  private readonly rs: Uint8Array;
  private e: DhKeyPair | undefined;
  private re: Uint8Array | undefined;
  private step = 0; // 0: ilk mesaj, 1: ikinci mesaj, 2: tamamlandı
  private readonly fixedE: DhKeyPair | undefined;

  constructor(opts: NoiseKKOptions) {
    if (opts.rs.length !== DHLEN) throw new CryptoError("INVALID_KEY", "Karşı statik anahtar 32 bayt olmalı.");
    this.initiator = opts.initiator;
    this.s = opts.s;
    this.rs = opts.rs.slice();
    this.fixedE = opts.testOnlyEphemeral;
    this.ss = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.ss.mixHash(opts.prologue);
    // Ön mesajlar: "-> s" sonra "<- s"
    if (this.initiator) {
      this.ss.mixHash(this.s.publicKey);
      this.ss.mixHash(this.rs);
    } else {
      this.ss.mixHash(this.rs);
      this.ss.mixHash(this.s.publicKey);
    }
  }

  private myTurnToWrite(): boolean {
    return (this.step === 0 && this.initiator) || (this.step === 1 && !this.initiator);
  }

  isComplete(): boolean {
    return this.step === 2;
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.step >= 2 || !this.myTurnToWrite()) {
      throw new CryptoError("HANDSHAKE_STATE", "Sıra bu tarafta değil.");
    }
    if (payload.length + DHLEN + TAGLEN > NOISE_MAX_MESSAGE) {
      throw new CryptoError("INVALID_INPUT", "Noise mesajı çok büyük.");
    }
    this.e = this.fixedE ?? generateDhKeyPair();
    this.ss.mixHash(this.e.publicKey);
    if (this.step === 0) {
      // -> e, es, ss
      this.ss.mixKey(dh(this.e.secretKey, this.rs));
      this.ss.mixKey(dh(this.s.secretKey, this.rs));
    } else {
      // <- e, ee, se   (yanıtlayan: se = DH(e, rs))
      if (!this.re) throw new CryptoError("HANDSHAKE_STATE");
      this.ss.mixKey(dh(this.e.secretKey, this.re));
      this.ss.mixKey(dh(this.e.secretKey, this.rs));
    }
    const out = concat(this.e.publicKey, this.ss.encryptAndHash(payload));
    this.step++;
    return out;
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.step >= 2 || this.myTurnToWrite()) {
      throw new CryptoError("HANDSHAKE_STATE", "Bu tarafın okuma sırası değil.");
    }
    if (message.length < DHLEN + TAGLEN || message.length > NOISE_MAX_MESSAGE) {
      throw new CryptoError("INVALID_INPUT", "Geçersiz Noise mesaj uzunluğu.");
    }
    const re = message.slice(0, DHLEN);
    this.re = re;
    this.ss.mixHash(re);
    if (this.step === 0) {
      // yanıtlayan okur: e, es (= DH(s, re)), ss
      this.ss.mixKey(dh(this.s.secretKey, re));
      this.ss.mixKey(dh(this.s.secretKey, this.rs));
    } else {
      // başlatan okur: e, ee, se (= DH(s, re))
      if (!this.e) throw new CryptoError("HANDSHAKE_STATE");
      this.ss.mixKey(dh(this.e.secretKey, re));
      this.ss.mixKey(dh(this.s.secretKey, re));
    }
    const payload = this.ss.decryptAndHash(message.subarray(DHLEN));
    this.step++;
    return payload;
  }

  /** El sıkışma tamamlandıktan sonra taşıma anahtarlarını üretir ve geçici anahtarı siler. */
  split(): NoiseTransport {
    if (this.step !== 2) throw new CryptoError("HANDSHAKE_STATE", "El sıkışma tamamlanmadı.");
    const handshakeHash = this.ss.handshakeHash();
    const [c1, c2] = this.ss.split();
    if (this.e && !this.fixedE) wipe(this.e.secretKey);
    this.e = undefined;
    return this.initiator
      ? { send: c1, recv: c2, handshakeHash }
      : { send: c2, recv: c1, handshakeHash };
  }
}
