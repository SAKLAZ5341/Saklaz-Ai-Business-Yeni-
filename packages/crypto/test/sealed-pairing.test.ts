import { beforeAll, describe, expect, it } from "vitest";
import {
  computeSas,
  CryptoError,
  fromUtf8,
  generateDhKeyPair,
  generatePairingSecret,
  generateSigningKeyPair,
  initCrypto,
  open,
  openPairingMessage,
  pairingKey,
  seal,
  sealPairingMessage,
  toHex,
  utf8,
} from "../src/index.js";

beforeAll(initCrypto);

describe("mühürlü zarf (çevrimdışı alıcı)", () => {
  it("doğru alıcı ve doğru gönderen ile açılır", () => {
    const phone = generateDhKeyPair();
    const agent = generateDhKeyPair();
    const box = seal(phone, agent.publicKey, utf8("kuyruktaki komut"), utf8("env-1"));
    expect(fromUtf8(open(agent, phone.publicKey, box, utf8("env-1")))).toBe("kuyruktaki komut");
  });

  it("başka gönderen anahtarı (taklit), başka bağlam veya kurcalanmış zarf reddedilir", () => {
    const phone = generateDhKeyPair();
    const agent = generateDhKeyPair();
    const mallory = generateDhKeyPair();
    const box = seal(mallory, agent.publicKey, utf8("sahte"), utf8("env-1"));
    // Ajan, bu zarfı eşleştirilmiş telefondan bekliyor → açılamaz.
    expect(() => open(agent, phone.publicKey, box, utf8("env-1"))).toThrowError(CryptoError);

    const good = seal(phone, agent.publicKey, utf8("x"), utf8("env-1"));
    expect(() => open(agent, phone.publicKey, good, utf8("env-2"))).toThrowError(CryptoError);
    const tampered = { ...good, ciphertext: good.ciphertext.slice() };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;
    expect(() => open(agent, phone.publicKey, tampered, utf8("env-1"))).toThrowError(CryptoError);
    expect(() => open(agent, phone.publicKey, { ...good, nonce: new Uint8Array(12) }, utf8("env-1"))).toThrowError(
      CryptoError,
    );
    // Başka bir alıcı açamaz
    expect(() => open(generateDhKeyPair(), phone.publicKey, good, utf8("env-1"))).toThrowError(CryptoError);
  });

  it("aynı içerik her seferinde farklı şifreli metin üretir", () => {
    const a = generateDhKeyPair();
    const b = generateDhKeyPair();
    const c1 = seal(a, b.publicKey, utf8("x"), utf8("c"));
    const c2 = seal(a, b.publicKey, utf8("x"), utf8("c"));
    expect(toHex(c1.ciphertext)).not.toBe(toHex(c2.ciphertext));
  });
});

describe("eşleştirme ve SAS", () => {
  const keys = () => ({
    agentSign: generateSigningKeyPair(),
    agentDh: generateDhKeyPair(),
    phoneSign: generateSigningKeyPair(),
    phoneDh: generateDhKeyPair(),
  });

  it("iki taraf aynı 6 haneli SAS'ı hesaplar", () => {
    const k = keys();
    const secret = generatePairingSecret();
    const input = {
      secret,
      agentSignPub: k.agentSign.publicKey,
      agentDhPub: k.agentDh.publicKey,
      phoneSignPub: k.phoneSign.publicKey,
      phoneDhPub: k.phoneDh.publicKey,
    };
    const sas = computeSas(input);
    expect(sas).toMatch(/^\d{6}$/);
    expect(computeSas({ ...input })).toBe(sas);
  });

  it("relay telefonun anahtarını değiştirirse SAS değişir (MITM görünür olur)", () => {
    const k = keys();
    const secret = generatePairingSecret();
    const base = {
      secret,
      agentSignPub: k.agentSign.publicKey,
      agentDhPub: k.agentDh.publicKey,
      phoneSignPub: k.phoneSign.publicKey,
      phoneDhPub: k.phoneDh.publicKey,
    };
    const swapped = { ...base, phoneDhPub: generateDhKeyPair().publicKey };
    expect(computeSas(swapped)).not.toBe(computeSas(base));
    expect(() => computeSas({ ...base, secret: new Uint8Array(16) })).toThrowError(CryptoError);
  });

  it("eşleştirme mesajı yalnızca S ile, doğru aşama ve oturumda açılır", () => {
    const s = generatePairingSecret();
    const box = sealPairingMessage(s, "pair-req", "sess-1", utf8("telefon anahtarları"));
    expect(fromUtf8(openPairingMessage(s, "pair-req", "sess-1", box))).toBe("telefon anahtarları");
    expect(() => openPairingMessage(generatePairingSecret(), "pair-req", "sess-1", box)).toThrowError(CryptoError);
    expect(() => openPairingMessage(s, "pair-ok", "sess-1", box)).toThrowError(CryptoError);
    expect(() => openPairingMessage(s, "pair-req", "sess-2", box)).toThrowError(CryptoError);
    expect(toHex(pairingKey(s, "pair-req", "a"))).not.toBe(toHex(pairingKey(s, "pair-ok", "a")));
  });
});
