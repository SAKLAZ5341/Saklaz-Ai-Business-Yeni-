import { beforeAll, describe, expect, it } from "vitest";
import { generateSigningKeyPair, utf8 } from "@saklaz/crypto";
import {
  buildHeader,
  decodeInnerMessage,
  encodeInnerMessage,
  MAX_INNER_MESSAGE_BYTES,
  parseInnerMessage,
  ProtocolError,
  signInnerMessage,
  uuidv7,
  verifyInnerMessageSignature,
} from "../src/index.js";
import { AGENT_ID, makePhone, NOW, send, setup, TASK, WS } from "./helpers.js";

// fakeB64 kripto başlatıldıktan sonra çağrılabilir; sıfır özetin metin karşılığı sabit yazıldı.
const RH = { seq: 0, hash: "A".repeat(43) };

beforeAll(setup);

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};

describe("imzalı iç mesaj", () => {
  it("imzalanır, kodlanır, çözülür ve doğrulanır", () => {
    const p = makePhone();
    const m = send(p, "cmd.create", { taskId: TASK, text: "Raporlar klasöründeki Excel dosyalarını özetle" });
    const back = decodeInnerMessage(encodeInnerMessage(m));
    expect(() => verifyInnerMessageSignature(back, p.sign.publicKey)).not.toThrow();
    expect(back.body).toEqual(m.body);
  });

  it("gövde, başlık veya imza değiştirilirse doğrulama başarısız olur", () => {
    const p = makePhone();
    const m = send(p, "cmd.create", { taskId: TASK, text: "özetle" });
    const tamperedBody = { ...m, body: { ...m.body, text: "sil" } };
    expect(code(() => verifyInnerMessageSignature(tamperedBody, p.sign.publicKey))).toBe("SIGNATURE_INVALID");
    const tamperedHdr = { ...m, hdr: { ...m.hdr, exp: m.hdr.exp + 1000 } };
    expect(code(() => verifyInnerMessageSignature(tamperedHdr, p.sign.publicKey))).toBe("SIGNATURE_INVALID");
    expect(code(() => verifyInnerMessageSignature(m, generateSigningKeyPair().publicKey))).toBe("SIGNATURE_INVALID");
  });

  it("şemaya uymayan mesaj hiçbir zaman imzalanmaz", () => {
    const p = makePhone();
    const hdr = buildHeader({ type: "cmd.create", ws: WS, rh: RH, from: p.id, to: AGENT_ID, ctr: 1, ts: NOW });
    // bilinmeyen alan
    expect(code(() => signInnerMessage(hdr, { taskId: TASK, text: "x", extra: 1 } as never, p.sign))).toBe(
      "SCHEMA_INVALID",
    );
    // boş komut
    expect(code(() => signInnerMessage(hdr, { taskId: TASK, text: "" }, p.sign))).toBe("SCHEMA_INVALID");
  });

  it("onay ekranını yanıltabilecek yön/kontrol karakterleri reddedilir", () => {
    const p = makePhone();
    const hdr = buildHeader({ type: "cmd.create", ws: WS, rh: RH, from: p.id, to: AGENT_ID, ctr: 1, ts: NOW });
    expect(code(() => signInnerMessage(hdr, { taskId: TASK, text: "rapor‮gpj.exe" }, p.sign))).toBe(
      "SCHEMA_INVALID",
    );
    expect(code(() => signInnerMessage(hdr, { taskId: TASK, text: "a\u0000b" }, p.sign))).toBe("SCHEMA_INVALID");
  });

  it("ömür sınırları: exp ≤ ts ve tipin üst sınırını aşan ömür reddedilir", () => {
    const p = makePhone();
    const hdr = buildHeader({ type: "history.query", ws: WS, rh: RH, from: p.id, to: AGENT_ID, ctr: 1, ts: NOW, lifetimeMs: 3_600_000 });
    expect(code(() => signInnerMessage(hdr, { sinceSeq: 0, limit: 10 }, p.sign))).toBe("EXPIRY_TOO_LONG");
    const bad = { ...buildHeader({ type: "history.query", ws: WS, rh: RH, from: p.id, to: AGENT_ID, ctr: 1, ts: NOW }), exp: NOW };
    expect(code(() => signInnerMessage(bad, { sinceSeq: 0, limit: 10 }, p.sign))).toBe("SCHEMA_INVALID");
    // cmd.create çevrimdışı bilgisayar için 72 saate kadar kuyrukta bekleyebilir
    const q = buildHeader({ type: "cmd.create", ws: WS, rh: RH, from: p.id, to: AGENT_ID, ctr: 1, ts: NOW, lifetimeMs: 72 * 3_600_000 });
    expect(() => signInnerMessage(q, { taskId: TASK, text: "x" }, p.sign)).not.toThrow();
  });

  it("desteklenmeyen protokol sürümü ayrıca bildirilir", () => {
    const p = makePhone();
    const m = send(p, "cmd.cancel", { taskId: TASK });
    expect(code(() => parseInnerMessage({ ...m, hdr: { ...m.hdr, proto: "saklaz/2" } }))).toBe("UNSUPPORTED_VERSION");
    expect(code(() => parseInnerMessage({ ...m, hdr: null }))).toBe("SCHEMA_INVALID");
    expect(code(() => parseInnerMessage({ ...m, extra: 1 }))).toBe("SCHEMA_INVALID");
  });

  it("kanonik olmayan base64 imza, tipli şema hatası olarak reddedilir (regresyon: Sprint 1 özellik testi)", () => {
    const p = makePhone();
    const m = send(p, "cmd.create", { taskId: TASK, text: "x" });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(m.sig.charAt(85));
    const nonCanonical = m.sig.slice(0, 85) + alphabet.charAt(last + 1); // dolgu biti 1 olur
    expect(code(() => parseInnerMessage({ ...m, sig: nonCanonical }))).toBe("SCHEMA_INVALID");
  });

  it("boyut sınırı, bozuk UTF-8 ve JSON olmayan veri reddedilir", () => {
    expect(code(() => decodeInnerMessage(new Uint8Array(MAX_INNER_MESSAGE_BYTES + 1)))).toBe("SCHEMA_INVALID");
    expect(code(() => decodeInnerMessage(new Uint8Array([0xff, 0xfe])))).toBe("SCHEMA_INVALID");
    expect(code(() => decodeInnerMessage(utf8("{bozuk")))).toBe("SCHEMA_INVALID");
  });

  it("UUIDv7 biçimi ve zaman sıralaması", () => {
    const a = uuidv7(NOW);
    const b = uuidv7(NOW + 1);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
