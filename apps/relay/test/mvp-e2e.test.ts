/**
 * MVP alfa uçtan uca: gerçek relay HTTP/WebSocket + PostgreSQL + ajan servisi (şifreli kasa, SQLCipher)
 * + üretim telefon istemcisi (@saklaz/client-core). Test simülatörü KULLANILMAZ.
 *
 * Kapsam: hesap oluşturma, parola+TOTP girişi, cihaz kaydı (anahtar kanıtı), QR+SAS eşleştirme, iki
 * bilgisayar, izinli komut ve sonuç, izinsiz komutun reddi, tekrar oynatma, telefon ve ajanın yeniden
 * başlatılması (kalıcı kimlik).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "jose";
import { initCrypto } from "@saklaz/crypto";
import type { InnerMessage } from "@saklaz/protocol";
import { AgentService, KeyProtectionError, type KeyProtector } from "@saklaz/agent";
import { decodePairingQr, PhoneClient, RelayApi, RelayConnection, TokenManager, type ReceivedFrame } from "@saklaz/client-core";
import { Accounts, buildRelay, createPool, migrate, RecordingPush, totp, type Pool } from "../src/index.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const HAS_PG = pgAvailable();

/** Testte DPAPI yerine: kullanıcıya özgü AES-GCM sarmalayıcı (Windows'ta gerçek DPAPI ayrıca sınanır). */
class TestProtector implements KeyProtector {
  readonly kind = "test-fake" as const;
  private readonly key = createHash("sha256").update("mvp-e2e-user").digest();
  binding() {
    return { userSid: "S-1-5-21-1-2-3-1001", machineGuid: "11111111-2222-3333-4444-555555555555" };
  }
  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(entropy);
    const ct = Buffer.concat([c.update(kek), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array {
    try {
      const b = Buffer.from(blob);
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAAD(entropy);
      d.setAuthTag(b.subarray(12, 28));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    } catch {
      throw new KeyProtectionError("UNWRAP_FAILED");
    }
  }
}

function b32decode(b32: string): Uint8Array {
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
}

let lastErrors: string[] = [];
async function waitFor(cond: () => boolean, ms = 8000, what = "koşul") {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`zaman aşımı: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!HAS_PG)("MVP alfa uçtan uca: hesap → eşleştirme → komut (iki bilgisayar)", () => {
  let pgi: TestPg;
  let pool: Pool;
  let relayUrl: string;
  let closeRelay: () => Promise<void>;
  // TOTP tekrar kullanım koruması (A1): her giriş farklı bir 30 sn adımı ister; saat testte ilerletilir.
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const dirs: string[] = [];
  const services: AgentService[] = [];
  const conns: RelayConnection[] = [];
  const noLog = (l: string, e: string, m?: object) => { if (process.env["MVP_DEBUG"]) console.log("AGENT", l, e, JSON.stringify(m ?? {})); };

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    pool = createPool(pgi.url);
    await migrate(pool);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const accounts = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey: randomBytes(32), issuer: "saklaz-mvp", now });
    const { app } = buildRelay({ pool, accounts, relayId: "relay-mvp", push: new RecordingPush(), authRatePerMinute: 1000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const a = app.server.address();
    if (!a || typeof a === "string") throw new Error("adres");
    relayUrl = `ws://127.0.0.1:${String(a.port)}`;
    closeRelay = () => app.close();
  });

  afterAll(async () => {
    for (const c of conns) c.stop();
    for (const s of services) s.close();
    await closeRelay();
    await pool.end();
    await pgi.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function nextCode(secret: Uint8Array): string {
    clockOffset += 31_000;
    return totp(secret, now());
  }

  function newAgent(dir?: string): AgentService {
    const d = dir ?? mkdtempSync(join(tmpdir(), "saklaz-mvp-agent-"));
    if (!dir) dirs.push(d);
    const s = new AgentService({ profile: "personal", dir: d, protector: new TestProtector(), log: noLog, allowInsecureRelay: true });
    services.push(s);
    return s;
  }

  function phoneLink(phone: PhoneClient, tokens: TokenManager) {
    const inbox: InnerMessage[] = [];
    const errors: string[] = [];
    const raw: ReceivedFrame[] = [];
    const conn: RelayConnection = new RelayConnection({
      url: `${relayUrl}/v1/connect`,
      deviceId: phone.id,
      sign: phone.sign,
      getToken: () => tokens.get(),
      onFrames: (frames) => {
        raw.push(...frames);
        const r = phone.receive(frames);
        inbox.push(...r.messages);
        errors.push(...r.errors);
        lastErrors = errors;
        conn.send(r.replies);
      },
    });
    conns.push(conn);
    conn.start();
    return { conn, inbox, errors, raw };
  }

  async function pairAgent(agent: AgentService, phone: PhoneClient, conn: RelayConnection) {
    const client = agent.connect();
    await client.waitReady(8000);
    const qr = decodePairingQr(agent.startPairing());
    conn.send([phone.startPairing(qr, agent.config?.label ?? "PC")]);
    const sas = await agent.waitForSas(8000);
    expect(sas).toBe(phone.sasFor(qr)); // iki ekranda aynı kod
    expect(agent.confirmPairing(true)).toBe(true);
    await agent.waitLinked(8000);
  }

  async function command(phone: PhoneClient, conn: RelayConnection, inbox: InnerMessage[], to: string, text: string) {
    const taskId = randomUUID();
    conn.send(phone.send(to, "cmd.create", { taskId, text }, { lifetimeMs: 3_600_000 }));
    const done = () =>
      inbox.find((m) => m.hdr.type === "task.event" && (m.body as { taskId: string; seq: number }).taskId === taskId && (m.body as { seq: number }).seq === 2);
    await waitFor(() => !!done(), 8000, `komut sonucu: ${text} errs=${JSON.stringify(lastErrors)} inbox=${inbox.map((m) => m.hdr.type + ":" + JSON.stringify(m.body).slice(0, 80)).join("|")}`);
    return done() as InnerMessage & { body: { status: string; summary?: string; error?: { code: string } } };
  }

  it("tam akış", async () => {
    const api = new RelayApi(relayUrl);
    const email = "mvp@ornek.com.tr";
    const password = "çok-gizli-bir-parola-42";
    const reg = await api.register(email, password);
    const secret = b32decode(new URL(reg.otpauth).searchParams.get("secret") ?? "");

    // Telefon: çalışma alanı + giriş + cihaz kaydı
    const phone = PhoneClient.createWorkspace({ label: "Test telefonu", now });
    const login = await api.login(email, password, nextCode(secret));
    expect(await api.registerDevice(login.accessToken, login.accountId, phone.id, "phone", phone.sign)).toBe("created");
    expect(await api.registerDevice(login.accessToken, login.accountId, phone.id, "phone", phone.sign)).toBe("exists");
    let savedRefresh = login.refreshToken;
    const tokens = new TokenManager(api, login.refreshToken, (t) => {
      savedRefresh = t;
    }, now);
    const P = phoneLink(phone, tokens);

    // Bilgisayar 1 ve 2 (ayrı kimlik, ayrı klasör, ayrı kasa)
    const A = newAgent();
    A.configure(relayUrl, "Şirket bilgisayarı");
    await A.login(email, password, nextCode(secret));
    const B = newAgent();
    B.configure(relayUrl, "Ev bilgisayarı");
    await B.login(email, password, nextCode(secret));
    expect(A.core.deviceId).not.toBe(B.core.deviceId);

    await pairAgent(A, phone, P.conn);
    await pairAgent(B, phone, P.conn);
    expect(phone.computers().map((c) => [c.label, c.role])).toEqual([
      ["Şirket bilgisayarı", "owner"],
      ["Ev bilgisayarı", "owner"],
    ]);
    // Yeni bilgisayar, telefonun bütün listesini (ilk bilgisayar dahil) gördü
    expect(B.core.rosterLog?.current.devices.has(A.core.deviceId)).toBe(true);

    // İzinli komut: doğru bilgisayardan, imzalı sonuç
    const ra = await command(phone, P.conn, P.inbox, A.core.deviceId, "sistem");
    expect(ra.hdr.from).toBe(A.core.deviceId);
    expect(ra.body.status).toBe("succeeded");
    expect(ra.body.summary).toContain("Bilgisayar:");
    const rb = await command(phone, P.conn, P.inbox, B.core.deviceId, "ping");
    expect(rb.hdr.from).toBe(B.core.deviceId);
    expect(rb.body.summary).toMatch(/^pong/);

    // İzinsiz komut: reddedilir, hiçbir şey çalışmaz
    const bad = await command(phone, P.conn, P.inbox, A.core.deviceId, "del /s /q C:\\");
    expect(bad.body.status).toBe("failed");
    expect(bad.body.error?.code).toBe("NOT_ALLOWED");

    // Tekrar oynatma: aynı çerçeveler yeniden verilince yeni mesaj üretilmez
    const before = P.inbox.length;
    const replay = phone.receive(P.raw.slice(-3));
    expect(replay.messages).toHaveLength(0);
    expect(P.inbox.length).toBe(before);

    // Telefon yeniden başlatma: güvenli depodaki durumdan geri yükleme, yeni bağlantı
    P.conn.stop();
    const phone2 = PhoneClient.restore(phone.exportState(), now);
    const tokens2 = new TokenManager(api, savedRefresh, (t) => {
      savedRefresh = t;
    }, now);
    const P2 = phoneLink(phone2, tokens2);
    const r2 = await command(phone2, P2.conn, P2.inbox, B.core.deviceId, "disk");
    expect(r2.body.status).toBe("succeeded");

    // Ajan yeniden başlatma: aynı klasör → aynı kimlik, şifreli kasa açılır, komut çalışır
    const dirA = A.dir;
    const idA = A.core.deviceId;
    A.close();
    const A2 = newAgent(dirA);
    expect(A2.core.deviceId).toBe(idA);
    expect(A2.isLoggedIn).toBe(true);
    A2.connect();
    const r3 = await command(phone2, P2.conn, P2.inbox, idA, "çalışma süresi");
    expect(r3.body.status).toBe("succeeded");
    expect(P2.errors.filter((e) => e !== "DECRYPT_FAILED")).toEqual([]);

    // Relay'de düz metin yok: komut metinleri ve sonuçlar veritabanında görünmez
    const dump = JSON.stringify((await pool.query("SELECT * FROM envelopes")).rows) + JSON.stringify((await pool.query("SELECT * FROM audit_meta")).rows);
    expect(dump).not.toContain("Bilgisayar:");
    expect(dump).not.toContain("NOT_ALLOWED");
  }, 60_000);
});
