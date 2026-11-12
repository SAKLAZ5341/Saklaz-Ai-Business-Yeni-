/**
 * Uçtan uca entegrasyon: gerçek relay + gerçek PostgreSQL + ajan çekirdeği (SQLCipher) + telefon simülatörü,
 * gerçek WebSocket bağlantıları üzerinden.
 *
 * Kapsam: eşleştirme, imzalı cihaz listesi, imzalı komut, "relay'de düz metin yok", kuyruk + acil kilit,
 * relay'in sahte zarf eklemesi ve relay'in iptal mesajını iletmemesi (S3, S4, S16 kısmi, S21, S23).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "jose";
import { computeSas, fromB64, generateDhKeyPair, initCrypto, seal, toB64, concat, utf8 } from "@saklaz/crypto";
import type { WireOut } from "@saklaz/protocol";
import { AgentCore, MemoryVault, RelayClient } from "@saklaz/agent";
import { PhoneSim } from "@saklaz/testkit";
import { Accounts, buildRelay, createPool, migrate, RecordingPush, totp, type Pool } from "../src/index.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const HAS_PG = pgAvailable();
const WS = "ws_personalE2E000000001";
const PLAINTEXT_MARKER = "GIZLI-KOMUT-METNI-7f3a";
const TASK = "01934b6e-0000-7000-8000-0000000000e2";

async function waitFor(cond: () => boolean, ms = 5000, what = "koşul") {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`zaman aşımı: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!HAS_PG)("uçtan uca: relay + ajan + telefon", () => {
  let pgi: TestPg;
  let pool: Pool;
  let accounts: Accounts;
  let port: number;
  let closeRelay: () => Promise<void>;
  let token: string;
  let accountId: string;
  const dirs: string[] = [];
  const clients: RelayClient[] = [];

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    pool = createPool(pgi.url);
    await migrate(pool);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    accounts = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey: randomBytes(32), issuer: "saklaz-e2e" });
    const { app } = buildRelay({ pool, accounts, relayId: "relay-e2e", push: new RecordingPush(), authRatePerMinute: 1000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const a = app.server.address();
    if (!a || typeof a === "string") throw new Error("adres");
    port = a.port;
    closeRelay = () => app.close();
    const reg = await accounts.register("sahip@ornek.com.tr", "çok-gizli-parola-123");
    const secret = Uint8Array.from(
      (() => {
        const b32 = new URL(reg.otpauth).searchParams.get("secret") ?? "";
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
        return out;
      })(),
    );
    const login = await accounts.login("sahip@ornek.com.tr", "çok-gizli-parola-123", totp(secret, Date.now()));
    token = login.accessToken;
    accountId = login.accountId;
  });

  afterAll(async () => {
    for (const c of clients) c.stop(); // başarısız testlerde bile yeniden bağlanma döngüsü bırakılmaz
    await closeRelay();
    await pool.end();
    await pgi.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Cihaz kaydı uç noktası (anahtar kanıtıyla) relay.test.ts'de sınandı; burada doğrudan eklenir. */
  async function registerDevice(deviceId: string, kind: "phone" | "computer", signPub: Uint8Array) {
    await pool.query("INSERT INTO devices (device_id, account_id, kind, sign_pub) VALUES ($1, $2, $3, $4)", [deviceId, accountId, kind, toB64(signPub)]);
  }

  function makeAgent() {
    const dir = mkdtempSync(join(tmpdir(), "saklaz-e2e-"));
    dirs.push(dir);
    let client: RelayClient | undefined;
    const agent = new AgentCore({ dbPath: join(dir, "agent.db"), vault: new MemoryVault(), onLockdown: () => client?.stop(), label: "Ev bilgisayarı" });
    const lastRejected: string[] = [];
    const accepted: string[] = [];
    const mkClient = () => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${port}/v1/connect`,
        deviceId: agent.deviceId,
        sign: agent.sign,
        getToken: () => token,
        onFrames: (frames) => {
          const r = agent.processIncoming(frames);
          lastRejected.push(...r.rejected.map((x) => x.code));
          accepted.push(...r.accepted.map((m) => m.hdr.type));
          client?.send(r.out);
        },
      });
      clients.push(client);
      client.start();
      return client;
    };
    return { agent, mkClient, lastRejected, accepted, client: () => client };
  }

  function makePhone(id: string) {
    const phone = new PhoneSim(id, WS);
    const pairFrames: string[] = [];
    const client = new RelayClient({
      url: `ws://127.0.0.1:${port}/v1/connect`,
      deviceId: id,
      sign: phone.sign,
      getToken: () => token,
      onFrames: (frames) => {
        for (const f of frames) if (f.kind === "pair") pairFrames.push(f.ct);
        const replies = phone.receive(frames.filter((f) => f.kind !== "pair"));
        client.send(replies);
      },
    });
    clients.push(client);
    return { phone, client, pairFrames, send: (outs: WireOut[]) => client.send(outs) };
  }

  it("eşleştirme relay üzerinden yapılır; imzalı komut bilgisayara ulaşır, imzalı yanıt telefona döner; relay'de düz metin yok", async () => {
    const A = makeAgent();
    await registerDevice(A.agent.deviceId, "computer", A.agent.sign.publicKey);
    const P = makePhone("dev_e2eOwnerPhone00000001");
    await registerDevice(P.phone.id, "phone", P.phone.sign.publicKey);
    const agentClient = A.mkClient();
    P.client.start();
    await agentClient.waitReady();
    await P.client.waitReady();

    // 1) Eşleştirme: QR ekranda (bant dışı); istek relay üzerinden S ile şifreli gider
    P.phone.createWorkspace();
    const qr = A.agent.startPairing();
    P.send([P.phone.scanQr(qr, "Ev bilgisayarı")]);
    await waitFor(() => A.agent.pairingSas() !== undefined, 5000, "SAS");
    const phoneSas = computeSas({
      secret: fromB64(qr.secret),
      agentSignPub: fromB64(qr.signPub),
      agentDhPub: fromB64(qr.dhPub),
      phoneSignPub: P.phone.sign.publicKey,
      phoneDhPub: P.phone.dh.publicKey,
    });
    expect(A.agent.pairingSas()).toBe(phoneSas);
    const ok = A.agent.confirmPairing(true);
    if (!ok) throw new Error("onay yok");
    agentClient.send([ok]);
    await waitFor(() => P.pairFrames.length > 0, 5000, "pair-ok");
    const link = P.phone.completePairing(P.pairFrames[0] ?? "");
    P.send(P.phone.send(A.agent.deviceId, "roster.append", { entries: link as never }));
    await waitFor(() => A.agent.rosterHead?.seq === 2, 5000, "bağ");

    // 2) Bilgisayar çevrimdışıyken komut gönderilir → relay kuyruğunda yalnızca şifreli metin olmalı
    agentClient.stop();
    await new Promise((r) => setTimeout(r, 100));
    P.send(P.phone.send(A.agent.deviceId, "cmd.create", { taskId: TASK, text: PLAINTEXT_MARKER }, { lifetimeMs: 3_600_000 }));
    await new Promise((r) => setTimeout(r, 200));
    const q = await pool.query<{ ct: string; kind: string }>("SELECT ct, kind FROM envelopes WHERE to_device = $1", [A.agent.deviceId]);
    expect(q.rows.length).toBeGreaterThan(0);
    const secretBytes = Buffer.from(PLAINTEXT_MARKER, "utf8");
    for (const row of q.rows) {
      expect(row.ct).not.toContain(PLAINTEXT_MARKER);
      expect(Buffer.from(row.ct, "base64url").includes(secretBytes)).toBe(false);
      expect(Buffer.from(row.ct, "base64url").includes(Buffer.from("cmd.create"))).toBe(false);
    }
    const dump = JSON.stringify((await pool.query("SELECT * FROM audit_meta")).rows) + JSON.stringify((await pool.query("SELECT * FROM devices")).rows);
    expect(dump).not.toContain(PLAINTEXT_MARKER);
    expect(dump).not.toContain(qr.secret); // eşleştirme sırrı relay'e hiç ulaşmadı

    // 3) Bilgisayar yeniden bağlanır, kuyruktaki komutu alır, imzalı ack + olay döner
    A.mkClient();
    await waitFor(() => A.accepted.includes("cmd.create"), 5000, "komut kabulü");
    await waitFor(() => P.phone.inbox.some((m) => m.hdr.type === "task.event"), 5000, "olay");
    expect(P.phone.inbox.some((m) => m.hdr.type === "ack")).toBe(true);
    // Teslim edilen zarflar relay'den silindi
    await new Promise((r) => setTimeout(r, 200));
    const left = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM envelopes WHERE to_device = $1", [A.agent.deviceId]);
    expect(left.rows[0]?.n).toBe(0);

    // 4) Ele geçirilmiş relay: telefonun kimliğiyle sahte zarf ekler (kendi anahtarıyla mühürlenmiş)
    const mallory = generateDhKeyPair();
    const fake = seal(mallory, fromB64(qr.dhPub), utf8('{"sahte":true}'), utf8(`SAKLAZ-v1/sealed|${WS}|${P.phone.id}|${A.agent.deviceId}`));
    const before = A.lastRejected.length;
    await pool.query(
      "INSERT INTO envelopes (id, account_id, from_device, to_device, kind, ct, size, expires_at) VALUES (gen_random_uuid(), $1, $2, $3, 'sealed', $4, 10, now() + interval '1 hour')",
      [accountId, P.phone.id, A.agent.deviceId, toB64(concat(fake.ephemeralPublicKey, fake.nonce, fake.ciphertext))],
    );
    // Relay ajanı tetikler (yeniden bağlanma ile kuyruk boşaltılır)
    A.client()?.stop();
    A.mkClient();
    await waitFor(() => A.lastRejected.length > before, 5000, "sahte zarf reddi");
    expect(A.lastRejected.slice(before)).toContain("DECRYPT_FAILED");
    expect(A.accepted.filter((t) => t === "cmd.create")).toHaveLength(1); // sahte komut çalışmadı

    A.client()?.stop();
    P.client.stop();
    A.agent.close();
  });

  it("acil kilit kuyrukta bekliyorsa, bilgisayar bağlanınca önce o uygulanır ve bağlantı kesilir (S21)", async () => {
    const A = makeAgent();
    await registerDevice(A.agent.deviceId, "computer", A.agent.sign.publicKey);
    const P = makePhone("dev_e2eLockPhone000000001");
    await registerDevice(P.phone.id, "phone", P.phone.sign.publicKey);
    let agentClient = A.mkClient();
    P.client.start();
    await agentClient.waitReady();
    await P.client.waitReady();
    P.phone.createWorkspace();
    const qr = A.agent.startPairing();
    P.send([P.phone.scanQr(qr)]);
    await waitFor(() => A.agent.pairingSas() !== undefined);
    const ok = A.agent.confirmPairing(true);
    if (!ok) throw new Error("onay yok");
    agentClient.send([ok]);
    await waitFor(() => P.pairFrames.length > 0);
    P.send(P.phone.send(A.agent.deviceId, "roster.append", { entries: P.phone.completePairing(P.pairFrames[0] ?? "") as never }));
    await waitFor(() => A.agent.rosterHead?.seq === 2);

    agentClient.stop();
    await new Promise((r) => setTimeout(r, 100));
    P.phone.channel?.dropPeer(A.agent.deviceId); // çevrimdışı alıcıya: mühürlü zarflar
    P.send(P.phone.send(A.agent.deviceId, "cmd.create", { taskId: TASK, text: "rapor 1" }, { lifetimeMs: 3_600_000 }));
    P.send(P.phone.send(A.agent.deviceId, "cmd.create", { taskId: TASK, text: "rapor 2" }, { lifetimeMs: 3_600_000 }));
    P.send(P.phone.send(A.agent.deviceId, "agent.lockdown", { reason: "telefon kayboldu" }, { lifetimeMs: 3_600_000 }));
    await new Promise((r) => setTimeout(r, 300));
    agentClient = A.mkClient();
    await waitFor(() => A.agent.lockdown.locked, 5000, "kilit");
    expect(A.accepted.filter((t) => t === "cmd.create")).toHaveLength(0);
    expect(A.lastRejected.filter((c) => c === "LOCKED").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => !agentClient.isReady, 3000, "bağlantı kesme");
    P.client.stop();
    A.agent.close();
  });

  it("relay bir iptal girişini iletmezse (S23): iptal edilen telefon komut göndermeye devam edebilir; bir sonraki meşru mesajdaki liste başı (rh) bunu ortaya çıkarır ve iptal uygulanır", async () => {
    const A = makeAgent();
    await registerDevice(A.agent.deviceId, "computer", A.agent.sign.publicKey);
    const O = makePhone("dev_e2eOwnerPhone00000003");
    const S = makePhone("dev_e2eStolenPhone0000003");
    await registerDevice(O.phone.id, "phone", O.phone.sign.publicKey);
    await registerDevice(S.phone.id, "phone", S.phone.sign.publicKey);
    const agentClient = A.mkClient();
    O.client.start();
    S.client.start();
    await Promise.all([agentClient.waitReady(), O.client.waitReady(), S.client.waitReady()]);
    O.phone.createWorkspace();
    const qr = A.agent.startPairing();
    O.send([O.phone.scanQr(qr)]);
    await waitFor(() => A.agent.pairingSas() !== undefined);
    const ok = A.agent.confirmPairing(true);
    if (!ok) throw new Error("onay yok");
    agentClient.send([ok]);
    await waitFor(() => O.pairFrames.length > 0);
    const link = O.phone.completePairing(O.pairFrames[0] ?? "");
    const add = O.phone.ownerAdd(S.phone.device(false), S.phone.sign.secretKey);
    const linkS = O.phone.ownerEntry("link.set", { phoneId: S.phone.id, computerId: A.agent.deviceId, role: "operator" });
    O.send(O.phone.send(A.agent.deviceId, "roster.append", { entries: [...link, add, linkS] as never }));
    await waitFor(() => A.agent.rosterHead?.seq === 4, 5000, "ikinci telefon");
    S.phone.syncRosterFrom(O.phone);

    // Sahip, ikinci telefonu iptal eder — ama relay bu zarfı ajana iletmeden siler (engelleme).
    agentClient.stop();
    await new Promise((r) => setTimeout(r, 100));
    const revoke = O.phone.ownerEntry("device.revoke", { deviceId: S.phone.id, reason: "çalındı" });
    O.send(O.phone.send(A.agent.deviceId, "roster.append", { entries: [revoke] as never }, { lifetimeMs: 3_600_000 }));
    await new Promise((r) => setTimeout(r, 300));
    const withheld = await pool.query("DELETE FROM envelopes WHERE from_device = $1 AND to_device = $2", [O.phone.id, A.agent.deviceId]);
    expect(withheld.rowCount).toBeGreaterThan(0);

    // KALAN RİSK (belgelendi): iptali öğrenemeyen ajan, iptal edilmiş telefonun komutunu kabul eder.
    A.mkClient();
    await A.client()?.waitReady();
    S.send(S.phone.send(A.agent.deviceId, "cmd.create", { taskId: TASK, text: "çalınan telefondan" }));
    await waitFor(() => A.accepted.includes("cmd.create"), 5000, "riskli kabul");

    // Önlem: sahibin bir sonraki meşru mesajı yeni liste başını (rh) taşır → ajan geride olduğunu anlar.
    // Relay iptal zarfını silerken bir Noise mesajı da kayboldu; ajan oturumu sıfırlar (yeni el sıkışma).
    // Telefon, yanıt alamadığı mesajı yeniden gönderir (gerçek uygulamadaki outbox davranışı).
    for (let attempt = 0; attempt < 5 && !A.lastRejected.includes("ROSTER_BEHIND"); attempt++) {
      O.send(O.phone.send(A.agent.deviceId, "history.query", { sinceSeq: 0, limit: 1 }));
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(A.lastRejected).toContain("ROSTER_BEHIND");
    await waitFor(() => O.phone.inbox.some((m) => m.hdr.type === "roster.need"), 5000, "roster.need");
    O.send(O.phone.send(A.agent.deviceId, "roster.append", { entries: [revoke] as never }));
    await waitFor(() => A.agent.rosterHead?.seq === 5, 5000, "iptal uygulandı");
    const before = A.accepted.filter((t) => t === "cmd.create").length;
    S.send(S.phone.send(A.agent.deviceId, "cmd.create", { taskId: TASK, text: "tekrar deneme" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(A.accepted.filter((t) => t === "cmd.create")).toHaveLength(before); // artık reddediliyor

    A.client()?.stop();
    O.client.stop();
    S.client.stop();
    A.agent.close();
  });
});
