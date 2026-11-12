import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertValidSignature,
  blake2b,
  concat,
  CryptoError,
  dh,
  dhKeyPairFromSecret,
  equalConstantTime,
  fromB64,
  fromHex,
  fromUtf8,
  generateDhKeyPair,
  generateSigningKeyPair,
  hkdf,
  initCrypto,
  randomBytes,
  sign,
  signingKeyPairFromSeed,
  taggedHash,
  toB64,
  toHex,
  utf8,
  verify,
  wipe,
} from "../src/index.js";
import { hmacBlake2b, noiseHkdf } from "../src/hash.js";
import { chachaDecrypt, chachaEncrypt, xchachaDecrypt, xchachaEncrypt } from "../src/aead.js";
import { sodium } from "../src/sodium.js";

beforeAll(initCrypto);

describe("BLAKE2b ve HMAC", () => {
  it("RFC 7693 Ek A: BLAKE2b-512('abc')", () => {
    expect(toHex(blake2b(utf8("abc")))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("geçersiz çıktı uzunluğu reddedilir", () => {
    expect(() => blake2b(utf8("x"), 8)).toThrowError(CryptoError);
    expect(() => blake2b(utf8("x"), 65)).toThrowError(CryptoError);
  });

  it("etiketli özet farklı etiketlerde farklıdır (alan ayrımı)", () => {
    expect(toHex(taggedHash("a", utf8("x")))).not.toBe(toHex(taggedHash("b", utf8("x"))));
  });

  it("HMAC: uzun anahtar önce özetlenir (RFC 2104) ve tutarlıdır", () => {
    const longKey = new Uint8Array(200).fill(7);
    expect(toHex(hmacBlake2b(longKey, utf8("m")))).toBe(toHex(hmacBlake2b(blake2b(longKey), utf8("m"))));
  });

  it("Noise HKDF 3 çıktı modu ve RFC 5869 HKDF uzunluk/bağlam davranışı", () => {
    const outs = noiseHkdf(new Uint8Array(64), utf8("ikm"), 3);
    expect(outs).toHaveLength(3);
    expect(new Set(outs.map(toHex)).size).toBe(3);
    const k1 = hkdf(utf8("ikm"), utf8("salt"), "ctx-a", 100);
    expect(k1).toHaveLength(100);
    expect(toHex(hkdf(utf8("ikm"), utf8("salt"), "ctx-a", 32))).toBe(toHex(k1.subarray(0, 32)));
    expect(toHex(hkdf(utf8("ikm"), utf8("salt"), "ctx-b", 32))).not.toBe(toHex(k1.subarray(0, 32)));
    expect(hkdf(utf8("ikm"), new Uint8Array(0), "ctx", 16)).toHaveLength(16);
    expect(() => hkdf(utf8("ikm"), utf8("s"), "ctx", 0)).toThrowError(CryptoError);
  });
});

describe("Ed25519 imza ve alan ayrımı", () => {
  it("RFC 8032 §7.1 TEST 1 (libsodium çekirdeği, alan öneki olmadan)", () => {
    const kp = signingKeyPairFromSeed(
      fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
    );
    expect(toHex(kp.publicKey)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const sig = sodium().crypto_sign_detached(new Uint8Array(0), kp.secretKey);
    expect(toHex(sig)).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  it("imza doğrulanır; mesaj, anahtar veya alan değişirse geçersizdir", () => {
    const kp = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const msg = utf8("cmd.create");
    const sig = sign("SAKLAZ-v1/msg", msg, kp.secretKey);
    expect(verify("SAKLAZ-v1/msg", msg, sig, kp.publicKey)).toBe(true);
    expect(verify("SAKLAZ-v1/approval", msg, sig, kp.publicKey)).toBe(false);
    expect(verify("SAKLAZ-v1/msg", utf8("cmd.cancel"), sig, kp.publicKey)).toBe(false);
    expect(verify("SAKLAZ-v1/msg", msg, sig, other.publicKey)).toBe(false);
    expect(verify("SAKLAZ-v1/msg", msg, sig.subarray(0, 63), kp.publicKey)).toBe(false);
    expect(verify("SAKLAZ-v1/msg", msg, sig, new Uint8Array(31))).toBe(false);
    expect(() => assertValidSignature("SAKLAZ-v1/msg", utf8("x"), sig, kp.publicKey)).toThrowError(CryptoError);
    expect(() => assertValidSignature("SAKLAZ-v1/msg", msg, sig, kp.publicKey)).not.toThrow();
  });

  it("bilinmeyen alan ve geçersiz anahtar reddedilir", () => {
    const kp = generateSigningKeyPair();
    // @ts-expect-error — tür sisteminin dışından gelen bilinmeyen alan
    expect(() => sign("SAKLAZ-v1/other", utf8("x"), kp.secretKey)).toThrowError(CryptoError);
    expect(() => sign("SAKLAZ-v1/msg", utf8("x"), new Uint8Array(32))).toThrowError(CryptoError);
    expect(() => signingKeyPairFromSeed(new Uint8Array(16))).toThrowError(CryptoError);
  });

  it("özellik: rastgele mesajlarda tek bit değişikliği imzayı geçersiz kılar", () => {
    const kp = generateSigningKeyPair();
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.nat(), (m, pos) => {
        const sig = sign("SAKLAZ-v1/msg", m, kp.secretKey);
        const t = m.slice();
        const i = pos % t.length;
        t[i] = (t[i] ?? 0) ^ 1;
        return verify("SAKLAZ-v1/msg", m, sig, kp.publicKey) && !verify("SAKLAZ-v1/msg", t, sig, kp.publicKey);
      }),
      { numRuns: 200 },
    );
  });
});

describe("X25519", () => {
  it("RFC 7748 §6.1 Alice/Bob ortak sırrı", () => {
    const alice = dhKeyPairFromSecret(fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
    const bob = dhKeyPairFromSecret(fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"));
    expect(toHex(alice.publicKey)).toBe("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
    expect(toHex(dh(alice.secretKey, bob.publicKey))).toBe(shared);
    expect(toHex(dh(bob.secretKey, alice.publicKey))).toBe(shared);
  });

  it("düşük dereceli noktalar (sıfır ortak sır) reddedilir", () => {
    const k = generateDhKeyPair();
    expect(() => dh(k.secretKey, new Uint8Array(32))).toThrowError(CryptoError);
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(() => dh(k.secretKey, one)).toThrowError(CryptoError);
    expect(() => dh(k.secretKey, new Uint8Array(31))).toThrowError(CryptoError);
  });
});

describe("AEAD", () => {
  it("ChaCha20-Poly1305 ve XChaCha20-Poly1305: tur, yanlış AD ve kurcalama", () => {
    const key = randomBytes(32);
    const n12 = randomBytes(12);
    const ct = chachaEncrypt(key, n12, utf8("ad"), utf8("pt"));
    expect(fromUtf8(chachaDecrypt(key, n12, utf8("ad"), ct))).toBe("pt");
    expect(() => chachaDecrypt(key, n12, utf8("başka"), ct)).toThrowError(CryptoError);
    const n24 = randomBytes(24);
    const xct = xchachaEncrypt(key, n24, utf8("ad"), utf8("pt"));
    expect(fromUtf8(xchachaDecrypt(key, n24, utf8("ad"), xct))).toBe("pt");
    expect(() => xchachaDecrypt(key, n24, utf8("ad"), xct.subarray(1))).toThrowError(CryptoError);
    expect(() => chachaEncrypt(new Uint8Array(16), n12, utf8(""), utf8(""))).toThrowError(CryptoError);
    expect(() => xchachaEncrypt(key, n12, utf8(""), utf8(""))).toThrowError(CryptoError);
  });
});

describe("bayt yardımcıları", () => {
  it("base64url tur ve geçersiz girdi", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 128 }), (b) => equalConstantTime(fromB64(toB64(b)), b)));
    expect(() => fromB64("a+b/")).toThrowError(CryptoError);
    expect(() => fromB64("a")).toThrowError(CryptoError);
    expect(() => fromHex("abc")).toThrowError(CryptoError);
  });

  it("sabit zamanlı eşitlik, birleştirme, sıfırlama, UTF-8", () => {
    expect(equalConstantTime(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(equalConstantTime(utf8("a"), utf8("ab"))).toBe(false);
    expect(equalConstantTime(utf8("ab"), utf8("ac"))).toBe(false);
    expect(fromUtf8(concat(utf8("a"), utf8("ç")))).toBe("aç");
    const s = utf8("gizli");
    wipe(s);
    expect([...s].every((b) => b === 0)).toBe(true);
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow();
  });
});
