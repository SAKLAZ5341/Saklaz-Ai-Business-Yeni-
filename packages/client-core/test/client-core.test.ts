import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateSigningKeyPair, initCrypto, randomBytes, toB64, verify, fromB64 } from "@saklaz/crypto";
import { canonicalBytes, relayAuthPayload } from "@saklaz/protocol";
import {
  connectUrl,
  decodePairingQr,
  encodePairingQr,
  httpBaseFromRelay,
  PhoneClient,
  RelayApi,
  RelayApiError,
  RelayConnection,
  TokenManager,
  ttlFor,
  type PairingQr,
  type WebSocketLike,
} from "../src/index.js";

beforeAll(initCrypto);

function qr(over: Partial<PairingQr> = {}): PairingQr {
  return {
    agentId: `dev_${toB64(randomBytes(16))}`,
    signPub: toB64(generateSigningKeyPair().publicKey),
    dhPub: toB64(randomBytes(32)),
    secret: toB64(randomBytes(32)),
    sessionId: toB64(randomBytes(12)),
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

describe("eşleştirme kodu", () => {
  it("gidiş-dönüş ve doğrulama", () => {
    const q = qr({ relay: "wss://relay.ornek.com" });
    expect(decodePairingQr(` ${encodePairingQr(q)}\n`)).toEqual(q);
    for (const bad of ["", "SAKLAZ1:", "SAKLAZ1:@@@", "X" + encodePairingQr(q), "SAKLAZ1:" + "A".repeat(3000)]) {
      expect(() => decodePairingQr(bad)).toThrow("QR_INVALID");
    }
    for (const over of [{ agentId: "dev_x" }, { secret: toB64(randomBytes(16)) }, { relay: "http://x.com" }, { expiresAt: "1" as unknown as number }, { dhPub: toB64(randomBytes(31)) }]) {
      expect(() => decodePairingQr(encodePairingQr({ ...q, ...over }))).toThrow("QR_INVALID");
    }
  });
});

describe("PhoneClient", () => {
  it("yeni çalışma alanı: sahip telefon, kalıcı durum, geri yükleme", () => {
    const p = PhoneClient.createWorkspace({ label: "Telefonum" });
    expect(p.id).toMatch(/^dev_/);
    expect(p.ws).toMatch(/^ws_/);
    expect(p.rosterHead.seq).toBe(0);
    expect(p.computers()).toEqual([]);
    const st = p.exportState();
    expect(st.entries).toHaveLength(1);
    const r = PhoneClient.restore(st);
    expect(r.id).toBe(p.id);
    expect(toB64(r.sign.publicKey)).toBe(toB64(p.sign.publicKey));
    expect(r.rosterHead).toEqual(p.rosterHead);
    expect(() => PhoneClient.restore({ ...st, ws: "bad" })).toThrow("STATE_INVALID");
    expect(() => PhoneClient.createWorkspace({ ws: "ws_kisa" })).toThrow("WS_INVALID");
    // durum kopyadır: dışarıdaki değişiklik istemciyi etkilemez
    st.ctr = 999;
    expect(p.exportState().ctr).toBe(0);
  });

  it("eşleştirme isteği: süresi geçmiş kod reddedilir; SAS iki tarafın anahtarlarına bağlıdır", () => {
    const p = PhoneClient.createWorkspace();
    expect(() => p.startPairing(qr({ expiresAt: Date.now() - 1 }), "PC")).toThrow("QR_EXPIRED");
    const q = qr();
    const out = p.startPairing(q, "PC");
    expect(out.kind).toBe("pair");
    expect(out.to).toBe(q.agentId);
    expect(p.pairingAgentId).toBe(q.agentId);
    const sas1 = p.sasFor(q);
    expect(sas1).toMatch(/\d/);
    expect(PhoneClient.createWorkspace().sasFor(q)).not.toBe(sas1);
    // bekleyen eşleştirme yokken veya başka göndericiden pair-ok
    expect(() => p.completePairing("dev_baskaBirCihaz0000000", "AAAA")).toThrow("NO_PENDING_PAIRING");
    const r = PhoneClient.createWorkspace().receive([{ from: q.agentId, kind: "pair", ct: "AAAA" }]);
    expect(r.errors).toEqual(["NO_PENDING_PAIRING"]);
  });

  it("bilinmeyen cihazdan çerçeve ve iptal edilemeyen cihaz", () => {
    const p = PhoneClient.createWorkspace();
    const r = p.receive([{ from: "dev_bilinmeyenCihaz00000", kind: "noise", ct: "AAAA" }]);
    expect(r.errors).toEqual(["DECRYPT_FAILED"]);
    expect(() => p.revoke("dev_bilinmeyenCihaz00000")).toThrow("UNKNOWN_DEVICE");
  });
});

describe("RelayApi ve TokenManager", () => {
  it("adres dönüşümleri", () => {
    expect(httpBaseFromRelay("wss://relay.ornek.com/x")).toBe("https://relay.ornek.com");
    expect(httpBaseFromRelay("ws://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
    expect(connectUrl("wss://relay.ornek.com")).toBe("wss://relay.ornek.com/v1/connect");
    expect(() => httpBaseFromRelay("https://relay.ornek.com")).toThrow(RelayApiError);
  });

  it("hata kodları, cihaz kaydı kanıtı, yenileme token'ı döndürme", async () => {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    let next: { status: number; body: unknown } = { status: 200, body: {} };
    const fetchFn = vi.fn((url: string, init: { headers: Record<string, string>; body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined, ...(init.headers["authorization"] ? { auth: init.headers["authorization"] } : {}) });
      return Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body) });
    });
    const api = new RelayApi("wss://r.ornek.com", fetchFn);
    next = { status: 401, body: { error: "INVALID_CREDENTIALS" } };
    await expect(api.login("a@b.co", "x", "123456")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    next = { status: 500, body: {} };
    await expect(api.register("a@b.co", "x")).rejects.toMatchObject({ code: "HTTP_ERROR" });

    const keys = generateSigningKeyPair();
    next = { status: 201, body: { ok: true } };
    expect(await api.registerDevice("tok", "acc-1", "dev_aaaaaaaaaaaaaaaaaaaa", "phone", keys)).toBe("created");
    const reg = calls.at(-1);
    expect(reg?.url).toBe("https://r.ornek.com/v1/devices");
    expect(reg?.auth).toBe("Bearer tok");
    const b = reg?.body as { proof: string; signPub: string };
    expect(verify("SAKLAZ-v1/relay-auth", canonicalBytes({ deviceId: "dev_aaaaaaaaaaaaaaaaaaaa", signPub: b.signPub, accountId: "acc-1" }), fromB64(b.proof), keys.publicKey)).toBe(true);
    next = { status: 409, body: { error: "DEVICE_EXISTS" } };
    expect(await api.registerDevice("tok", "acc-1", "dev_aaaaaaaaaaaaaaaaaaaa", "phone", keys)).toBe("exists");
    next = { status: 400, body: { error: "PROOF_INVALID" } };
    await expect(api.registerDevice("tok", "acc-1", "dev_aaaaaaaaaaaaaaaaaaaa", "phone", keys)).rejects.toMatchObject({ code: "PROOF_INVALID" });

    const failing = new RelayApi("wss://r.ornek.com", () => Promise.reject(new Error("ağ")));
    await expect(failing.refresh("x".repeat(20))).rejects.toMatchObject({ code: "NETWORK" });

    // TokenManager: önbellek, eşzamanlı tek yenileme, yeni yenileme token'ının kaydı
    let t = 0;
    const saved: string[] = [];
    next = { status: 200, body: { accessToken: "A1", refreshToken: "R2-xxxxxxxxxx" } };
    const tm = new TokenManager(api, "R1-xxxxxxxxxx", (r) => {
      saved.push(r);
    }, () => t);
    const [a, b2] = await Promise.all([tm.get(), tm.get()]);
    expect([a, b2]).toEqual(["A1", "A1"]);
    expect(saved).toEqual(["R2-xxxxxxxxxx"]);
    expect(await tm.get()).toBe("A1");
    t = 10 * 60_000;
    next = { status: 200, body: { accessToken: "A2", refreshToken: "R3-xxxxxxxxxx" } };
    expect(await tm.get()).toBe("A2");
    expect((calls.at(-1)?.body as { refreshToken: string }).refreshToken).toBe("R2-xxxxxxxxxx");
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(o: unknown) {
    this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) });
  }
}

describe("RelayConnection", () => {
  it("kimlik doğrulama, sıradaki gönderimler, teslim ve teslim onayı, varlık, yeniden bağlanma", async () => {
    const keys = generateSigningKeyPair();
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const got: unknown[] = [];
    const presence: unknown[] = [];
    let fail = false;
    const c = new RelayConnection({
      url: "ws://x/v1/connect",
      deviceId: "dev_aaaaaaaaaaaaaaaaaaaa",
      sign: keys,
      getToken: () => Promise.resolve("TOKEN"),
      onFrames: (f) => {
        if (fail) throw new Error("x");
        got.push(...f);
      },
      onState: (s, code) => states.push(code ? `${s}:${code}` : s),
      onPresence: (i) => presence.push(...i),
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      batchWindowMs: 1,
      minBackoffMs: 1,
    });
    c.start();
    c.start(); // ikinci çağrı etkisiz
    expect(sockets).toHaveLength(1);
    c.send([{ to: "dev_bbbbbbbbbbbbbbbbbbbb", kind: "sealed", ct: "AAAA" }]); // hazır değil → sıraya
    c.queryPresence([]);
    c.queryPresence(["dev_bbbbbbbbbbbbbbbbbbbb"]);
    const s = sockets[0] as FakeSocket;
    s.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.sent[0]).toEqual({ t: "auth", deviceId: "dev_aaaaaaaaaaaaaaaaaaaa", token: "TOKEN" });
    const nonce = toB64(randomBytes(32));
    s.push("{bozuk");
    s.push({ t: "bilinmeyen" });
    s.push({ t: "challenge", nonce, relayId: "relay-1" });
    const proof = s.sent[1] as { t: string; sig: string };
    expect(proof.t).toBe("auth.proof");
    expect(verify("SAKLAZ-v1/relay-auth", canonicalBytes(relayAuthPayload("dev_aaaaaaaaaaaaaaaaaaaa", nonce, "relay-1")), fromB64(proof.sig), keys.publicKey)).toBe(true);
    s.push({ t: "ready", deviceId: "dev_aaaaaaaaaaaaaaaaaaaa", queued: 0 });
    expect(c.isReady).toBe(true);
    expect(s.sent[2]).toMatchObject({ t: "send", to: "dev_bbbbbbbbbbbbbbbbbbbb", kind: "sealed", ttlSec: 72 * 3600 });
    expect(s.sent[3]).toEqual({ t: "presence.query", deviceIds: ["dev_bbbbbbbbbbbbbbbbbbbb"] });
    const id = "01934b6e-0000-7000-8000-000000000001";
    s.push({ t: "deliver", id, from: "dev_bbbbbbbbbbbbbbbbbbbb", kind: "noise", ct: "AAAA", sentAt: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1);
    expect(s.sent.at(-1)).toEqual({ t: "delivered", id });
    // İşleme hatası: teslim onayı gönderilmez (relay yeniden iletir)
    fail = true;
    const before = s.sent.length;
    s.push({ t: "deliver", id: "01934b6e-0000-7000-8000-000000000002", from: "dev_bbbbbbbbbbbbbbbbbbbb", kind: "noise", ct: "AAAA", sentAt: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.sent.length).toBe(before);
    s.push({ t: "presence", items: [{ deviceId: "dev_bbbbbbbbbbbbbbbbbbbb", online: true, lastSeen: null }] });
    expect(presence).toHaveLength(1);
    s.push({ t: "error", code: "RATE_LIMITED" });
    c.send([{ to: "dev_bbbbbbbbbbbbbbbbbbbb", kind: "noise", ct: "AAAA" }]);
    expect(s.sent.at(-1)).toMatchObject({ t: "send", ttlSec: 600 });
    // Bağlantı koptu → yeniden bağlanma
    s.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBeGreaterThan(1);
    c.stop();
    expect(states).toContain("ready");
    expect(states).toContain("error:RATE_LIMITED");
    expect(states).toContain("error:PROCESS_FAILED");
    expect(ttlFor("pair")).toBe(300);
  });

  it("token alınamazsa bağlantı kapatılır; geçersiz adres yeniden denenir", async () => {
    const states: string[] = [];
    const sockets: FakeSocket[] = [];
    const c = new RelayConnection({
      url: "ws://x",
      deviceId: "dev_aaaaaaaaaaaaaaaaaaaa",
      sign: generateSigningKeyPair(),
      getToken: () => Promise.reject(new Error("yok")),
      onFrames: () => undefined,
      onState: (s, code) => states.push(code ? `${s}:${code}` : s),
      createSocket: () => {
        if (sockets.length === 0) {
          sockets.push(new FakeSocket());
          throw new Error("adres");
        }
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      minBackoffMs: 1,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 20));
    const s = sockets[1] as FakeSocket;
    s.onerror?.({});
    s.open();
    await new Promise((r) => setTimeout(r, 5));
    c.stop();
    expect(states).toContain("error:URL_INVALID");
    expect(states).toContain("error:SOCKET_ERROR");
    expect(states).toContain("error:TOKEN_UNAVAILABLE");
  });
});
