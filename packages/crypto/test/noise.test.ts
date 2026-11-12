import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CryptoError,
  dhKeyPairFromSecret,
  fromHex,
  generateDhKeyPair,
  initCrypto,
  NoiseKK,
  NOISE_PROTOCOL_NAME,
  toHex,
  utf8,
} from "../src/index.js";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral: string;
  resp_remote_static: string;
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

const file = JSON.parse(
  readFileSync(new URL("./vectors/noise-kk-blake2b.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

beforeAll(initCrypto);

describe("Noise_KK resmî test vektörü (cacophony)", () => {
  it("vektör dosyası tam olarak bizim protokolümüzü içeriyor", () => {
    expect(file.vectors).toHaveLength(1);
    expect(file.vectors[0]?.protocol_name).toBe(NOISE_PROTOCOL_NAME);
  });

  for (const v of file.vectors) {
    it(`${v.protocol_name}: el sıkışma, özet ve taşıma mesajları birebir eşleşir`, () => {
      const init = new NoiseKK({
        initiator: true,
        prologue: fromHex(v.init_prologue),
        s: dhKeyPairFromSecret(fromHex(v.init_static)),
        rs: fromHex(v.init_remote_static),
        testOnlyEphemeral: dhKeyPairFromSecret(fromHex(v.init_ephemeral)),
      });
      const resp = new NoiseKK({
        initiator: false,
        prologue: fromHex(v.resp_prologue),
        s: dhKeyPairFromSecret(fromHex(v.resp_static)),
        rs: fromHex(v.resp_remote_static),
        testOnlyEphemeral: dhKeyPairFromSecret(fromHex(v.resp_ephemeral)),
      });

      const [m0, m1, ...transport] = v.messages;
      if (!m0 || !m1) throw new Error("vektör eksik");

      const c0 = init.writeMessage(fromHex(m0.payload));
      expect(toHex(c0)).toBe(m0.ciphertext);
      expect(toHex(resp.readMessage(c0))).toBe(m0.payload);

      const c1 = resp.writeMessage(fromHex(m1.payload));
      expect(toHex(c1)).toBe(m1.ciphertext);
      expect(toHex(init.readMessage(c1))).toBe(m1.payload);

      expect(init.isComplete()).toBe(true);
      expect(resp.isComplete()).toBe(true);
      const ti = init.split();
      const tr = resp.split();
      expect(toHex(ti.handshakeHash)).toBe(v.handshake_hash);
      expect(toHex(tr.handshakeHash)).toBe(v.handshake_hash);

      transport.forEach((m, i) => {
        const fromInit = i % 2 === 0;
        const [tx, rx] = fromInit ? [ti, tr] : [tr, ti];
        const ct = tx.send.encryptWithAd(new Uint8Array(0), fromHex(m.payload));
        expect(toHex(ct)).toBe(m.ciphertext);
        expect(toHex(rx.recv.decryptWithAd(new Uint8Array(0), ct))).toBe(m.payload);
      });
    });
  }
});

function pair(prologueA = "SAKLAZ-v1", prologueB = prologueA) {
  const a = generateDhKeyPair();
  const b = generateDhKeyPair();
  const init = new NoiseKK({ initiator: true, prologue: utf8(prologueA), s: a, rs: b.publicKey });
  const resp = new NoiseKK({ initiator: false, prologue: utf8(prologueB), s: b, rs: a.publicKey });
  return { a, b, init, resp };
}

describe("Noise_KK güvenlik özellikleri", () => {
  it("rastgele anahtarlarla tam tur çalışır ve her oturumda farklı anahtar üretir", () => {
    const run = () => {
      const { init, resp } = pair();
      resp.readMessage(init.writeMessage(utf8("merhaba")));
      init.readMessage(resp.writeMessage());
      const ti = init.split();
      const tr = resp.split();
      const ct = ti.send.encryptWithAd(new Uint8Array(0), utf8("komut"));
      expect(new TextDecoder().decode(tr.recv.decryptWithAd(new Uint8Array(0), ct))).toBe("komut");
      return toHex(ct);
    };
    expect(run()).not.toBe(run()); // geçici anahtarlar → ileri gizlilik, farklı şifreli metin
  });

  it("farklı önsöz (ör. başka cihaz kimliği veya protokol sürümü) el sıkışmayı bozar", () => {
    const { init, resp } = pair("SAKLAZ-v1|agentA|phone1", "SAKLAZ-v1|agentA|phone2");
    expect(() => resp.readMessage(init.writeMessage())).toThrowError(CryptoError);
  });

  it("sabitlenmemiş (sahte) statik anahtarla gelen el sıkışma reddedilir — relay MITM", () => {
    const a = generateDhKeyPair();
    const b = generateDhKeyPair();
    const mallory = generateDhKeyPair();
    // Saldırgan, B'nin A'yı beklediğini bilerek kendi anahtarıyla A taklidi yapar.
    const fake = new NoiseKK({ initiator: true, prologue: utf8("p"), s: mallory, rs: b.publicKey });
    const resp = new NoiseKK({ initiator: false, prologue: utf8("p"), s: b, rs: a.publicKey });
    expect(() => resp.readMessage(fake.writeMessage())).toThrowError(CryptoError);
  });

  it("bit değiştirilmiş el sıkışma ve taşıma mesajları reddedilir", () => {
    const { init, resp } = pair();
    const m0 = init.writeMessage(utf8("x"));
    const bad = m0.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    expect(() => resp.readMessage(bad)).toThrowError(CryptoError);

    const ok = pair();
    ok.resp.readMessage(ok.init.writeMessage());
    ok.init.readMessage(ok.resp.writeMessage());
    const ti = ok.init.split();
    const tr = ok.resp.split();
    const ct = ti.send.encryptWithAd(new Uint8Array(0), utf8("veri"));
    const t = ct.slice();
    t[0] = (t[0] ?? 0) ^ 0x80;
    expect(() => tr.recv.decryptWithAd(new Uint8Array(0), t)).toThrowError(CryptoError);
    // Kimlik doğrulama hatası nonce'u ilerletmez: asıl mesaj hâlâ çözülebilir.
    expect(tr.recv.nonce).toBe(0n);
    expect(new TextDecoder().decode(tr.recv.decryptWithAd(new Uint8Array(0), ct))).toBe("veri");
  });

  it("tekrar oynatılan taşıma mesajı reddedilir (nonce ilerlemiştir)", () => {
    const { init, resp } = pair();
    resp.readMessage(init.writeMessage());
    init.readMessage(resp.writeMessage());
    const ti = init.split();
    const tr = resp.split();
    const ct = ti.send.encryptWithAd(new Uint8Array(0), utf8("bir kez"));
    tr.recv.decryptWithAd(new Uint8Array(0), ct);
    expect(() => tr.recv.decryptWithAd(new Uint8Array(0), ct)).toThrowError(CryptoError);
  });

  it("sıra dışı çağrılar ve tamamlanmamış split reddedilir", () => {
    const { init, resp } = pair();
    expect(() => resp.writeMessage()).toThrowError(/Sıra/);
    expect(() => init.readMessage(new Uint8Array(48))).toThrowError(/okuma sırası/);
    expect(() => init.split()).toThrowError(/tamamlanmadı/);
    resp.readMessage(init.writeMessage());
    expect(() => init.writeMessage()).toThrowError(CryptoError);
    expect(() => resp.readMessage(new Uint8Array(10))).toThrowError(CryptoError);
  });

  it("geçersiz uzunluktaki mesajlar ve anahtarlar reddedilir", () => {
    const a = generateDhKeyPair();
    expect(() => new NoiseKK({ initiator: true, prologue: utf8(""), s: a, rs: new Uint8Array(31) })).toThrowError(CryptoError);
    const { init, resp } = pair();
    expect(() => init.writeMessage(new Uint8Array(65535))).toThrowError(/çok büyük/);
    expect(() => resp.readMessage(new Uint8Array(20))).toThrowError(/uzunluğu/);
  });

  it("rekey her iki tarafta uyumlu çalışır; eski anahtar yeni mesajı çözemez", () => {
    const { init, resp } = pair();
    resp.readMessage(init.writeMessage());
    init.readMessage(resp.writeMessage());
    const ti = init.split();
    const tr = resp.split();
    ti.send.rekey();
    const ct = ti.send.encryptWithAd(new Uint8Array(0), utf8("yeni"));
    expect(() => tr.recv.decryptWithAd(new Uint8Array(0), ct)).toThrowError(CryptoError);
    tr.recv.rekey();
    expect(new TextDecoder().decode(tr.recv.decryptWithAd(new Uint8Array(0), ct))).toBe("yeni");
  });
});
