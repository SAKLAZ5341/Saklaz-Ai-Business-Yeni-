import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";
import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { generateSigningKeyPair, initCrypto, sign, toB64, type SigningKeyPair } from "@saklaz/crypto";
import { canonicalBytes, relayAuthPayload, type ServerFrame } from "@saklaz/protocol";
import { Accounts, buildRelay, createPool, hotp, migrate, RecordingPush, totp, verifyAuditMeta, verifyTotp, type Pool } from "../src/index.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const HAS_PG = pgAvailable();

describe("TOTP (RFC 6238 Ek B, SHA-1)", () => {
  // RFC 6238 test sırrı: ASCII "12345678901234567890"
  const secret = new TextEncoder().encode("12345678901234567890");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("T=%i → %s", (t, expected) => {
    expect(hotp(secret, BigInt(Math.floor(t / 30)), 8)).toBe(expected);
  });
  it("±1 adım tolerans, hatalı biçim reddi", () => {
    const now = 1_794_000_000_000;
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });
});

describe.skipIf(!HAS_PG)("relay (gerçek PostgreSQL)", () => {
  let pgi: TestPg;
  let pool: Pool;
  let accounts: Accounts;
  let base: string;
  let wsUrl: string;
  let close: () => Promise<void>;
  let push: RecordingPush;
  const clock = { t: Date.now() };
  const mfaKey = randomBytes(32);

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    pool = createPool(pgi.url);
    await migrate(pool);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    accounts = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey, issuer: "saklaz-test", now: () => clock.t, maxFailures: 3 });
    push = new RecordingPush();
    // Test paketi aynı IP'den çok sayıda giriş yaptığı için sınır yükseltildi; sınırın kendisi ayrı testte doğrulanıyor.
    const { app } = buildRelay({ pool, accounts, relayId: "relay-test", push, now: () => clock.t, authRatePerMinute: 1000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("adres yok");
    base = `http://127.0.0.1:${addr.port}`;
    wsUrl = `ws://127.0.0.1:${addr.port}/v1/connect`;
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
    await pool.end();
    await pgi.stop();
  });

  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  const secretOf = (otpauth: string) => {
    const b32 = new URL(otpauth).searchParams.get("secret") ?? "";
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let val = 0;
    const out: number[] = [];
    for (const ch of b32) {
      val = (val << 5) | A.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        out.push((val >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Uint8Array.from(out);
  };

  async function newAccount(email: string) {
    const reg = await post("/v1/accounts", { email, password: "çok-gizli-parola-123" });
    expect(reg.status).toBe(201);
    const secret = secretOf(String(reg.body["otpauth"]));
    const login = await post("/v1/auth/login", { email, password: "çok-gizli-parola-123", code: totp(secret, clock.t) });
    expect(login.status).toBe(200);
    return { secret, token: String(login.body["accessToken"]), refresh: String(login.body["refreshToken"]), accountId: String(login.body["accountId"]) };
  }

  async function newDevice(token: string, accountId: string, id: string, kind: "phone" | "computer" = "phone") {
    const k = generateSigningKeyPair();
    const proof = toB64(sign("SAKLAZ-v1/relay-auth", canonicalBytes({ deviceId: id, signPub: toB64(k.publicKey), accountId }), k.secretKey));
    const r = await post("/v1/devices", { deviceId: id, kind, signPub: toB64(k.publicKey), proof }, token);
    expect(r.status).toBe(201);
    return k;
  }

  /** Ham WebSocket istemcisi: kimlik doğrulama adımlarını elle yürütür. */
  function connect(deviceId: string, token: string, key: SigningKeyPair, opts: { badProof?: boolean } = {}) {
    const ws = new WebSocket(wsUrl);
    const frames: ServerFrame[] = [];
    const waiters: ((f: ServerFrame) => void)[] = [];
    ws.on("message", (d) => {
      const f = JSON.parse(Buffer.isBuffer(d) ? d.toString("utf8") : Buffer.from(d as ArrayBuffer).toString("utf8")) as ServerFrame;
      frames.push(f);
      if (f.t === "challenge") {
        const signer = opts.badProof ? generateSigningKeyPair() : key;
        const sig = sign("SAKLAZ-v1/relay-auth", canonicalBytes(relayAuthPayload(deviceId, f.nonce, f.relayId)), signer.secretKey);
        ws.send(JSON.stringify({ t: "auth.proof", sig: toB64(sig) }));
      }
      for (const w of waiters.splice(0)) w(f);
    });
    const next = (pred: (f: ServerFrame) => boolean, ms = 3000) =>
      new Promise<ServerFrame>((resolve, reject) => {
        const found = frames.find(pred);
        if (found) { resolve(found); return; }
        const t = setTimeout(() => reject(new Error("zaman aşımı")), ms);
        const check = (f: ServerFrame) => {
          if (pred(f)) {
            clearTimeout(t);
            resolve(f);
          } else waiters.push(check);
        };
        waiters.push(check);
      });
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    ws.on("open", () => ws.send(JSON.stringify({ t: "auth", deviceId, token })));
    return { ws, frames, next, closed, send: (f: unknown) => ws.send(JSON.stringify(f)) };
  }

  const uuid = () => crypto.randomUUID();

  it("hesap: kayıt, parola + TOTP ile giriş; yanlış kodda ayrıntısız hata; zayıf parola reddi", async () => {
    const a = await newAccount("ali@ornek.com.tr");
    expect(a.token.split(".")).toHaveLength(3);
    const bad = await post("/v1/auth/login", { email: "ali@ornek.com.tr", password: "çok-gizli-parola-123", code: "000000" });
    expect(bad.status).toBe(401);
    expect(bad.body["error"]).toBe("INVALID_CREDENTIALS"); // MFA mı parola mı ayrımı sızmaz
    expect((await post("/v1/accounts", { email: "x@ornek.com.tr", password: "kisa" })).status).toBe(400);
    expect((await post("/v1/accounts", { email: "ALI@ornek.com.tr", password: "çok-gizli-parola-123" })).status).toBe(409);
  });

  it("kaba kuvvet: art arda hatalı girişler hesabı geçici olarak kilitler", async () => {
    const reg = await post("/v1/accounts", { email: "kilit@ornek.com.tr", password: "çok-gizli-parola-123" });
    const secret = secretOf(String(reg.body["otpauth"]));
    for (let i = 0; i < 3; i++) await post("/v1/auth/login", { email: "kilit@ornek.com.tr", password: "yanlis-parola-0000", code: "123456" });
    const locked = await post("/v1/auth/login", { email: "kilit@ornek.com.tr", password: "çok-gizli-parola-123", code: totp(secret, clock.t) });
    expect(locked.status).toBe(423);
  });

  it("yenileme token'ı tek kullanımlıktır; ikinci kullanım tüm aileyi iptal eder", async () => {
    const a = await newAccount("yenile@ornek.com.tr");
    const r1 = await post("/v1/auth/refresh", { refreshToken: a.refresh });
    expect(r1.status).toBe(200);
    const reuse = await post("/v1/auth/refresh", { refreshToken: a.refresh });
    expect(reuse.body["error"]).toBe("TOKEN_REUSED");
    // Meşru zincirin devamı da artık geçersiz
    const r2 = await post("/v1/auth/refresh", { refreshToken: String(r1.body["refreshToken"]) });
    expect(r2.status).toBe(401);
  });

  it("cihaz kaydı anahtar sahipliği kanıtı ister; kopya kimlik reddedilir; token olmadan kayıt yapılamaz", async () => {
    const a = await newAccount("cihaz@ornek.com.tr");
    const k = generateSigningKeyPair();
    const wrongProof = toB64(sign("SAKLAZ-v1/relay-auth", canonicalBytes({ deviceId: "dev_proofTest000000000001", signPub: toB64(k.publicKey), accountId: "baska" }), k.secretKey));
    expect((await post("/v1/devices", { deviceId: "dev_proofTest000000000001", kind: "phone", signPub: toB64(k.publicKey), proof: wrongProof }, a.token)).status).toBe(400);
    await newDevice(a.token, a.accountId, "dev_proofTest000000000002");
    const k2 = generateSigningKeyPair();
    const proof2 = toB64(sign("SAKLAZ-v1/relay-auth", canonicalBytes({ deviceId: "dev_proofTest000000000002", signPub: toB64(k2.publicKey), accountId: a.accountId }), k2.secretKey));
    expect((await post("/v1/devices", { deviceId: "dev_proofTest000000000002", kind: "phone", signPub: toB64(k2.publicKey), proof: proof2 })).status).toBe(401);
    expect((await post("/v1/devices", { deviceId: "dev_proofTest000000000002", kind: "phone", signPub: toB64(k2.publicKey), proof: proof2 }, a.token)).status).toBe(409);
  });

  it("WSS: cihaz anahtarı kanıtı olmadan bağlanılamaz; kimlik doğrulamadan önce çerçeve kabul edilmez", async () => {
    const a = await newAccount("ws@ornek.com.tr");
    const k = await newDevice(a.token, a.accountId, "dev_wsPhone00000000000001");
    const bad = connect("dev_wsPhone00000000000001", a.token, k, { badProof: true });
    await bad.next((f) => f.t === "error");
    expect(await bad.closed).toBe(4000);
    // Token başka hesaptan: cihaz bu hesaba ait değil
    const other = await newAccount("ws2@ornek.com.tr");
    const wrongAcc = connect("dev_wsPhone00000000000001", other.token, k);
    expect((await wrongAcc.next((f) => f.t === "error")).t).toBe("error");
    // Kimlik doğrulamadan "send"
    const raw = new WebSocket(wsUrl);
    await new Promise((r) => raw.on("open", r));
    raw.send(JSON.stringify({ t: "ping" }));
    expect(await new Promise<number>((r) => raw.on("close", (c) => r(c)))).toBe(4000);
    const ok = connect("dev_wsPhone00000000000001", a.token, k);
    expect((await ok.next((f) => f.t === "ready")).t).toBe("ready");
    ok.ws.close();
  });

  it("yönlendirme: aynı hesapta teslim + kuyruk + teslim onayıyla silme; başka hesaba yönlendirme yok; çevrimdışıysa içeriksiz uyandırma", async () => {
    const a = await newAccount("route@ornek.com.tr");
    const kp = await newDevice(a.token, a.accountId, "dev_routePhone00000000001");
    const kc = await newDevice(a.token, a.accountId, "dev_routeComputer00000001", "computer");
    const b = await newAccount("route2@ornek.com.tr");
    await newDevice(b.token, b.accountId, "dev_otherAccountDevice001");

    const phone = connect("dev_routePhone00000000001", a.token, kp);
    await phone.next((f) => f.t === "ready");
    const id1 = uuid();
    phone.send({ t: "send", id: id1, to: "dev_routeComputer00000001", kind: "sealed", ttlSec: 3600, ct: "U0lGUkVMSQ" });
    await phone.next((f) => f.t === "accepted");
    expect(push.calls).toContain("dev_routeComputer00000001"); // çevrimdışı → uyandırma (içeriksiz)
    phone.send({ t: "send", id: uuid(), to: "dev_otherAccountDevice001", kind: "sealed", ttlSec: 3600, ct: "QQ" });
    expect((await phone.next((f) => f.t === "error")).t).toBe("error");

    const comp = connect("dev_routeComputer00000001", a.token, kc);
    const ready = await comp.next((f) => f.t === "ready");
    expect(ready.t === "ready" && ready.queued).toBe(1);
    const d = await comp.next((f) => f.t === "deliver");
    expect(d.t === "deliver" && d.from).toBe("dev_routePhone00000000001");
    comp.send({ t: "delivered", id: id1 });
    await new Promise((r) => setTimeout(r, 100));
    const left = await pool.query("SELECT count(*)::int AS n FROM envelopes WHERE id = $1", [id1]);
    expect(left.rows[0]).toEqual({ n: 0 });
    phone.ws.close();
    comp.ws.close();
  });

  it("süresi dolan zarflar teslim edilmez ve temizlenir", async () => {
    const a = await newAccount("ttl@ornek.com.tr");
    const kp = await newDevice(a.token, a.accountId, "dev_ttlPhone000000000001");
    await newDevice(a.token, a.accountId, "dev_ttlComputer0000000001", "computer");
    const phone = connect("dev_ttlPhone000000000001", a.token, kp);
    await phone.next((f) => f.t === "ready");
    phone.send({ t: "send", id: uuid(), to: "dev_ttlComputer0000000001", kind: "sealed", ttlSec: 1, ct: "QQ" });
    await phone.next((f) => f.t === "accepted");
    await new Promise((r) => setTimeout(r, 1200));
    const r = await pool.query("DELETE FROM envelopes WHERE expires_at <= now() AND to_device = $1", ["dev_ttlComputer0000000001"]);
    expect(r.rowCount).toBe(1);
    phone.ws.close();
  });

  it("hız sınırı: saniyede çok fazla çerçeve gönderen bağlantı kapatılır", async () => {
    const a = await newAccount("rate@ornek.com.tr");
    const kp = await newDevice(a.token, a.accountId, "dev_ratePhone00000000001");
    const phone = connect("dev_ratePhone00000000001", a.token, kp);
    await phone.next((f) => f.t === "ready");
    for (let i = 0; i < 80; i++) phone.send({ t: "ping" });
    const err = await phone.next((f) => f.t === "error" && f.code === "RATE_LIMITED");
    expect(err.t).toBe("error");
  });

  it("hesap düzeyinde devre dışı bırakılan cihaz bağlanamaz", async () => {
    const a = await newAccount("disable@ornek.com.tr");
    const kp = await newDevice(a.token, a.accountId, "dev_disablePhone000000001");
    expect((await post("/v1/devices/dev_disablePhone000000001/disable", {}, a.token)).status).toBe(200);
    const phone = connect("dev_disablePhone000000001", a.token, kp);
    expect((await phone.next((f) => f.t === "error")).t).toBe("error");
  });

  it("kimlik doğrulama uçlarında IP başına hız sınırı uygulanır (429)", async () => {
    const strict = buildRelay({ pool, accounts, relayId: "relay-strict", push, now: () => clock.t, authRatePerMinute: 3 });
    await strict.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = strict.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("adres yok");
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${addr.port}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "yok@ornek.com.tr", password: "x", code: "000000" }),
      });
      codes.push(r.status);
    }
    await strict.app.close();
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it("meta veri denetim kaydı: zincir doğrulanır; veritabanında değiştirme ve silme reddedilir", async () => {
    expect((await verifyAuditMeta(pool)).ok).toBe(true);
    await expect(pool.query("UPDATE audit_meta SET action = 'sahte' WHERE id = 1")).rejects.toThrow(/yalnızca ekleme/);
    await expect(pool.query("DELETE FROM audit_meta WHERE id = 1")).rejects.toThrow(/yalnızca ekleme/);
    // Denetim kaydında içerik yok: yalnızca olay türleri ve kimlikler
    const r = await pool.query<{ details: unknown }>("SELECT details FROM audit_meta");
    expect(JSON.stringify(r.rows)).not.toMatch(/parola|password|U0lGUkVMSQ/);
  });
});
