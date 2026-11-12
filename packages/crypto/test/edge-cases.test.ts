import { describe, expect, it } from "vitest";
import { CipherState, CryptoError, generateDhKeyPair, initCrypto, open, seal, utf8 } from "../src/index.js";
import { sodium } from "../src/sodium.js";

describe("başlatma", () => {
  // Bu dosya ayrı bir modül örneğinde çalışır (vitest dosya izolasyonu), bu yüzden
  // initCrypto çağrılmadan önceki durum gerçekten test edilebilir.
  it("initCrypto çağrılmadan kripto kullanılamaz; sonra kullanılabilir ve ikinci çağrı zararsızdır", async () => {
    expect(() => sodium()).toThrowError(/initCrypto/);
    await initCrypto();
    await initCrypto();
    expect(() => sodium()).not.toThrow();
  });
});

describe("CipherState uç durumları", () => {
  it("anahtarsız durumda şifreleme yapılmaz (yalnızca el sıkışmanın ilk anı için) ve rekey reddedilir", async () => {
    await initCrypto();
    const cs = new CipherState();
    expect(cs.hasKey()).toBe(false);
    expect(cs.encryptWithAd(utf8(""), utf8("x"))).toEqual(utf8("x"));
    expect(cs.decryptWithAd(utf8(""), utf8("x"))).toEqual(utf8("x"));
    expect(() => cs.rekey()).toThrowError(CryptoError);
    cs.initializeKey(new Uint8Array(32).fill(1));
    expect(cs.hasKey()).toBe(true);
    cs.initializeKey(new Uint8Array(32).fill(2)); // eski anahtar silinip yenisi yüklenir
    cs.destroy();
    expect(cs.hasKey()).toBe(false);
  });

  it("nonce tükendiğinde şifreleme ve çözme reddedilir (2^64-1 ayrılmıştır)", async () => {
    await initCrypto();
    const cs = new CipherState();
    cs.initializeKey(new Uint8Array(32).fill(1));
    // Özel alana yalnızca testte erişiyoruz: 2^64 mesaj göndermek pratik değil.
    (cs as unknown as { n: bigint }).n = 0xffffffffffffffffn;
    expect(() => cs.encryptWithAd(utf8(""), utf8("x"))).toThrowError(CryptoError);
    expect(() => cs.decryptWithAd(utf8(""), new Uint8Array(17))).toThrowError(CryptoError);
  });
});

describe("mühürlü zarf deterministik mod (yalnızca test vektörleri için)", () => {
  it("sabit geçici anahtar ve nonce ile aynı çıktıyı üretir", async () => {
    await initCrypto();
    const a = generateDhKeyPair();
    const b = generateDhKeyPair();
    const fixed = { ephemeral: generateDhKeyPair(), nonce: new Uint8Array(24).fill(9) };
    const c1 = seal(a, b.publicKey, utf8("x"), utf8("c"), fixed);
    const c2 = seal(a, b.publicKey, utf8("x"), utf8("c"), fixed);
    expect(c1.ciphertext).toEqual(c2.ciphertext);
    expect(open(b, a.publicKey, c1, utf8("c"))).toEqual(utf8("x"));
  });
});
