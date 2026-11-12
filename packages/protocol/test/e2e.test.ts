import { beforeAll, describe, expect, it } from "vitest";
import { fromUtf8, generateDhKeyPair, initCrypto, toB64, utf8, type DhKeyPair } from "@saklaz/crypto";
import { ClientFrameSchema, E2EChannel, E2EError, ServerFrameSchema, relayAuthPayload, type WireOut } from "../src/index.js";

beforeAll(initCrypto);

const A = "dev_aaaaaaaaaaaaaaaaaaaaaa"; // kimlik sıralamasında küçük olan
const B = "dev_bbbbbbbbbbbbbbbbbbbbbb";
const WS = "ws_personalE2ETest000001";

function pair(opts: { now?: () => number; maxAge?: number; maxMsgs?: number } = {}) {
  const ka = generateDhKeyPair();
  const kb = generateDhKeyPair();
  const keys = new Map<string, DhKeyPair>([
    [A, ka],
    [B, kb],
  ]);
  const mk = (self: string, dh: DhKeyPair) =>
    new E2EChannel({
      ws: WS,
      selfId: self,
      selfDh: dh,
      now: opts.now ?? (() => 1_794_000_000_000),
      peerDhPub: (id) => keys.get(id)?.publicKey,
      ...(opts.maxAge !== undefined ? { sessionMaxAgeMs: opts.maxAge } : {}),
      ...(opts.maxMsgs !== undefined ? { sessionMaxMessages: opts.maxMsgs } : {}),
    });
  return { a: mk(A, ka), b: mk(B, kb), keys };
}

/** Çerçeveleri karşı tarafa teslim eder; yanıtları toplar. */
function deliver(to: E2EChannel, from: string, outs: WireOut[]) {
  const texts: string[] = [];
  const replies: WireOut[] = [];
  const events: string[] = [];
  for (const o of outs) {
    const r = to.receive(from, o.kind, o.ct);
    if (r.plaintext) texts.push(fromUtf8(r.plaintext));
    replies.push(...r.replies);
    if (r.event) events.push(r.event);
  }
  return { texts, replies, events };
}

describe("uçtan uca kanal", () => {
  it("ilk mesaj mühürlü zarfla gider ve el sıkışma başlar; sonrası Noise ile şifrelenir", () => {
    const { a, b } = pair();
    const first = a.send(B, utf8("merhaba"));
    expect(first.map((o) => o.kind)).toEqual(["hs1", "sealed"]);
    const r = deliver(b, A, first);
    expect(r.texts).toEqual(["merhaba"]);
    expect(r.events).toContain("session-established");
    deliver(a, B, r.replies); // hs2
    expect(a.hasSession(B)).toBe(true);
    const next = a.send(B, utf8("ikinci"));
    expect(next.map((o) => o.kind)).toEqual(["noise"]);
    expect(deliver(b, A, next).texts).toEqual(["ikinci"]);
    // Ters yön de çalışır
    expect(deliver(a, B, b.send(A, utf8("yanıt"))).texts).toEqual(["yanıt"]);
  });

  it("bilinmeyen karşı taraf ve bozuk çerçeve tipli hatayla reddedilir", () => {
    const { a, b } = pair();
    expect(() => a.send("dev_unknownPeer0000000000", utf8("x"))).toThrowError(E2EError);
    expect(() => b.receive(A, "sealed", "!!!")).toThrowError(E2EError);
    expect(() => b.receive(A, "sealed", toB64(new Uint8Array(10)))).toThrowError(E2EError);
    expect(() => b.receive(A, "sealed", toB64(new Uint8Array(100)))).toThrowError(E2EError);
  });

  it("başka bir anahtarla mühürlenmiş zarf (taklit) ve bozuk el sıkışma reddedilir", () => {
    const { b } = pair();
    const mallory = new E2EChannel({
      ws: WS,
      selfId: A,
      selfDh: generateDhKeyPair(),
      now: () => 0,
      peerDhPub: () => generateDhKeyPair().publicKey,
    });
    const forged = mallory.send(B, utf8("sahte"));
    expect(() => deliver(b, A, forged)).toThrowError(E2EError);
  });

  it("eşzamanlı el sıkışma (glare): kimliği küçük olan başlatıcı kalır ve tek oturum kurulur", () => {
    const { a, b } = pair();
    const ha = a.startHandshake(B);
    const hb = b.startHandshake(A);
    if (!ha || !hb) throw new Error("el sıkışma yok");
    expect(a.receive(B, hb.kind, hb.ct).event).toBe("handshake-ignored"); // A küçük → kendi el sıkışmasını sürdürür
    const rb = b.receive(A, ha.kind, ha.ct); // B kendi isteğini bırakıp yanıtlar
    expect(rb.event).toBe("session-established");
    deliver(a, B, rb.replies);
    expect(a.hasSession(B) && b.hasSession(A)).toBe(true);
    expect(a.startHandshake(B)).toBeDefined(); // oturum varken yeni el sıkışma başlatılabilir (yenileme)
    expect(a.startHandshake(B)).toBeUndefined(); // ama aynı anda ikinci bekleyen olmaz
  });

  it("beklenmeyen hs2 yok sayılır; oturumsuz Noise mesajı oturum sıfırlaması başlatır", () => {
    const { a, b } = pair();
    const r = deliver(b, A, a.send(B, utf8("x")));
    deliver(a, B, r.replies);
    const n = a.send(B, utf8("y"));
    b.dropAll(); // B yeniden başladı: oturumu yok
    const res = b.receive(A, n[0]?.kind ?? "noise", n[0]?.ct ?? "");
    expect(res.event).toBe("session-reset");
    expect(res.replies.map((o) => o.kind)).toEqual(["hs1"]);
    expect(a.receive(B, "hs2", toB64(new Uint8Array(48))).event).toBe("handshake-ignored");
  });

  it("oturum süresi veya mesaj sınırı dolunca yeniden mühürlü zarf + el sıkışma yapılır", () => {
    let t = 1_794_000_000_000;
    const { a, b } = pair({ now: () => t, maxAge: 1000, maxMsgs: 3 });
    deliver(a, B, deliver(b, A, a.send(B, utf8("1"))).replies);
    expect(a.send(B, utf8("2"))[0]?.kind).toBe("noise");
    t += 2000;
    expect(a.send(B, utf8("3")).map((o) => o.kind)).toEqual(["hs1", "sealed"]);
  });

  it("geçersiz el sıkışma mesajı DECRYPT_FAILED verir ve bekleyen durumu temizler", () => {
    const { a, b } = pair();
    const hs = a.startHandshake(B);
    if (!hs) throw new Error("yok");
    const bad = toB64(new Uint8Array(48).fill(7));
    expect(() => b.receive(A, "hs1", bad)).toThrowError(E2EError);
    expect(() => a.receive(B, "hs2", bad)).toThrowError(E2EError);
  });
});

describe("relay tel protokolü şemaları", () => {
  it("geçerli çerçeveler kabul edilir, bilinmeyen alan ve tür reddedilir", () => {
    const send = { t: "send", id: "01934b6e-0000-7000-8000-000000000001", to: B, kind: "noise", ttlSec: 60, ct: "QUJD" };
    expect(ClientFrameSchema.safeParse(send).success).toBe(true);
    expect(ClientFrameSchema.safeParse({ ...send, extra: 1 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ ...send, kind: "plaintext" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ ...send, ttlSec: 73 * 3600 }).success).toBe(false);
    expect(ServerFrameSchema.safeParse({ t: "pong" }).success).toBe(true);
    expect(relayAuthPayload(A, "n", "r")).toEqual({ deviceId: A, nonce: "n", relayId: "r" });
  });
});
