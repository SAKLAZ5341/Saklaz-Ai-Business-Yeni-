/**
 * Sprint 3 A1 — TOTP tekrar kullanım koruması (SECURITY.md S1).
 *
 * Kapsam: aynı kodun ikinci kez kabul edilmemesi; tüketilmiş adımdan eski bir adımın kodunun
 * reddi; ±1 adım toleransının sınırları (süre aşımı); aynı kodla eşzamanlı istekler; sunucu
 * yeniden başlatıldıktan sonra korumanın sürmesi; ayrı relay kurulumlarının (PERSONAL / BUSINESS)
 * ve aynı relay'deki hesapların birbirinden bağımsızlığı; tekrar kullanımların kilitlenme sayacına
 * eklenmesi. Tamamı gerçek PostgreSQL ile çalışır.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";
import { randomBytes } from "node:crypto";
import { initCrypto } from "@saklaz/crypto";
import { Accounts, AuthError, buildRelay, createPool, hotp, matchTotpStep, migrate, RecordingPush, totp, totpStep, type Pool } from "../src/index.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const HAS_PG = pgAvailable();
const PASSWORD = "çok-gizli-parola-123";
/** Bir adımın tam ortası: kenar etkisi olmadan ±1 adım hesaplanabilir. */
const T0 = 1_794_000_000_000 + 15_000;
const STEP_MS = 30_000;

function secretOf(otpauth: string): Uint8Array {
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
}

/** Belirli bir adımın kodu. */
const codeAt = (secret: Uint8Array, step: bigint) => hotp(secret, step);

describe("matchTotpStep (birim)", () => {
  const secret = new TextEncoder().encode("12345678901234567890");
  const s = totpStep(T0);
  it("eşleşen adımı döndürür: −1, 0, +1", () => {
    expect(matchTotpStep(secret, codeAt(secret, s - 1n), T0)).toBe(s - 1n);
    expect(matchTotpStep(secret, codeAt(secret, s), T0)).toBe(s);
    expect(matchTotpStep(secret, codeAt(secret, s + 1n), T0)).toBe(s + 1n);
  });
  it("pencere dışındaki ve hatalı biçimli kodlar eşleşmez", () => {
    expect(matchTotpStep(secret, codeAt(secret, s - 2n), T0)).toBeUndefined();
    expect(matchTotpStep(secret, codeAt(secret, s + 2n), T0)).toBeUndefined();
    expect(matchTotpStep(secret, "12345", T0)).toBeUndefined();
    expect(matchTotpStep(secret, "1234567", T0)).toBeUndefined();
    expect(matchTotpStep(secret, "12a456", T0)).toBeUndefined();
    expect(matchTotpStep(secret, "", T0)).toBeUndefined();
  });
});

describe.skipIf(!HAS_PG)("TOTP tekrar kullanım koruması (gerçek PostgreSQL)", () => {
  let personalPg: TestPg;
  let businessPg: TestPg;
  let personalPool: Pool;
  let businessPool: Pool;
  let personal: Accounts;
  let business: Accounts;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const mfaKey = randomBytes(32);
  const clock = { t: T0 };

  const makeAccounts = (pool: Pool, issuer: string, opts: { maxFailures?: number } = {}) =>
    new Accounts(pool, {
      jwtPrivateKey: keys.privateKey,
      jwtPublicKey: keys.publicKey,
      mfaKey,
      issuer,
      now: () => clock.t,
      maxFailures: opts.maxFailures ?? 50,
    });

  beforeAll(async () => {
    await initCrypto();
    keys = await generateKeyPair("EdDSA");
    // İki ayrı relay kurulumu (v0.3: kişisel VPS ve şirket sunucusu): ayrı veritabanları.
    personalPg = await startPg();
    businessPg = await startPg();
    personalPool = createPool(personalPg.url);
    businessPool = createPool(businessPg.url);
    await migrate(personalPool);
    await migrate(businessPool);
    personal = makeAccounts(personalPool, "relay-personal");
    business = makeAccounts(businessPool, "relay-business");
  }, 60_000);

  afterAll(async () => {
    await personalPool.end();
    await businessPool.end();
    await personalPg.stop();
    await businessPg.stop();
  });

  let n = 0;
  async function register(acc: Accounts = personal, email = `kullanici${++n}@ornek.com.tr`) {
    const reg = await acc.register(email, PASSWORD);
    return { email, accountId: reg.accountId, secret: secretOf(reg.otpauth) };
  }

  async function expectMfaRejected(p: Promise<unknown>) {
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AuthError && e.code === "MFA_INVALID");
  }

  async function auditActions(pool: Pool, accountId: string): Promise<string[]> {
    const r = await pool.query<{ action: string }>("SELECT action FROM audit_meta WHERE account_id = $1 ORDER BY id", [accountId]);
    return r.rows.map((x) => x.action);
  }

  it("aynı kod aynı adımda ikinci kez kabul edilmez; tekrar denetim kaydına yazılır", async () => {
    clock.t = T0;
    const u = await register();
    const code = totp(u.secret, clock.t);
    await personal.login(u.email, PASSWORD, code);
    expect(await personal.totpLastStep(u.accountId)).toBe(totpStep(T0));
    await expectMfaRejected(personal.login(u.email, PASSWORD, code));
    expect(await auditActions(personalPool, u.accountId)).toEqual(["account.registered", "login.ok", "login.totp_replay"]);
  });

  it("tüketilmiş adımdan ESKİ bir adımın kodu, pencere içinde olsa bile reddedilir; sonraki adım kabul edilir", async () => {
    clock.t = T0;
    const u = await register();
    const s = totpStep(T0);
    // Kullanıcı ileri saatli bir cihazdan +1 adımın kodunu kullandı.
    await personal.login(u.email, PASSWORD, codeAt(u.secret, s + 1n));
    // Saldırgan aynı dakika içinde gözlemlediği (veya tahmin ettiği) s ve s−1 kodlarını dener.
    await expectMfaRejected(personal.login(u.email, PASSWORD, codeAt(u.secret, s)));
    await expectMfaRejected(personal.login(u.email, PASSWORD, codeAt(u.secret, s - 1n)));
    // Zaman ilerleyince yeni adımın kodu kabul edilir.
    clock.t = T0 + 2 * STEP_MS;
    await personal.login(u.email, PASSWORD, codeAt(u.secret, s + 2n));
    expect(await personal.totpLastStep(u.accountId)).toBe(s + 2n);
  });

  it("süre aşımı: ±1 adım kabul, ±2 adım red; 90 sn sonra eski kod artık geçersiz", async () => {
    const s = totpStep(T0);
    clock.t = T0;
    const u = await register();
    await expectMfaRejected(personal.login(u.email, PASSWORD, codeAt(u.secret, s - 2n)));
    await expectMfaRejected(personal.login(u.email, PASSWORD, codeAt(u.secret, s + 2n)));
    await personal.login(u.email, PASSWORD, codeAt(u.secret, s - 1n)); // ilk kullanım: tolerans içinde

    // Hiç kullanılmamış bir kod da süresi dolunca geçersizdir.
    const v = await register();
    const fresh = codeAt(v.secret, s);
    clock.t = T0 + 3 * STEP_MS;
    await expectMfaRejected(personal.login(v.email, PASSWORD, fresh));
    expect(await personal.totpLastStep(v.accountId)).toBeUndefined();
  });

  it("aynı kodla eşzamanlı 12 istekten YALNIZCA BİRİ başarılı olur", async () => {
    clock.t = T0;
    const u = await register();
    const code = totp(u.secret, clock.t);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => personal.login(u.email, PASSWORD, code)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const r of rejected) expect((r.reason as AuthError).code).toBe("MFA_INVALID");
    const actions = await auditActions(personalPool, u.accountId);
    expect(actions.filter((a) => a === "login.ok")).toHaveLength(1);
    expect(actions.filter((a) => a === "login.totp_replay")).toHaveLength(11);
  });

  it("eşzamanlı başarısız denemeler sayaçta kaybolmaz (atomik artış)", async () => {
    clock.t = T0;
    const u = await register();
    await Promise.allSettled(Array.from({ length: 7 }, () => personal.login(u.email, PASSWORD, "000000")));
    const r = await personalPool.query<{ failed_logins: number }>("SELECT failed_logins FROM accounts WHERE id = $1", [u.accountId]);
    // "000000" bu sırrın −1/0/+1 adımlarından birinin kodu olabilir (≈ 3×10⁻⁶); öyleyse sayaç 6 olur.
    expect(r.rows[0]?.failed_logins).toBeGreaterThanOrEqual(6);
  });

  it("sunucu yeniden başlatılınca koruma sürer (yeni bağlantı havuzu, yeni süreç durumu, şema yeniden çalıştırılır)", async () => {
    clock.t = T0;
    const u = await register();
    const code = totp(u.secret, clock.t);
    await personal.login(u.email, PASSWORD, code);

    // "Yeniden başlatma": eski havuz kapatılır; yeni havuz ve yeni Accounts örneği oluşturulur.
    await personalPool.end();
    personalPool = createPool(personalPg.url);
    await migrate(personalPool); // idempotent; mevcut veriyi bozmaz
    personal = makeAccounts(personalPool, "relay-personal");

    expect(await personal.totpLastStep(u.accountId)).toBe(totpStep(T0));
    await expectMfaRejected(personal.login(u.email, PASSWORD, code));
  });

  it("gerçek HTTP uç noktası üzerinden: tekrar kullanılan kod 401 ve yanlış kodla aynı yanıt", async () => {
    clock.t = T0;
    const { app } = buildRelay({ pool: personalPool, accounts: personal, relayId: "relay-personal", push: new RecordingPush(), now: () => clock.t, authRatePerMinute: 1000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const addr = app.server.address();
      if (!addr || typeof addr === "string") throw new Error("adres yok");
      const base = `http://127.0.0.1:${addr.port}`;
      const post = async (body: unknown) => {
        const r = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      const u = await register();
      const code = totp(u.secret, clock.t);
      const parallel = await Promise.all(Array.from({ length: 5 }, () => post({ email: u.email, password: PASSWORD, code })));
      expect(parallel.filter((r) => r.status === 200)).toHaveLength(1);
      const replayed = parallel.filter((r) => r.status !== 200);
      expect(replayed).toHaveLength(4);
      const wrong = await post({ email: u.email, password: PASSWORD, code: code === "000000" ? "111111" : "000000" });
      for (const r of [...replayed, wrong]) {
        expect(r.status).toBe(401);
        expect(r.body).toEqual(wrong.body); // tekrar kullanım ayrı bir hata olarak sızdırılmaz
      }
      expect(wrong.body["error"]).toBe("INVALID_CREDENTIALS");
    } finally {
      await app.close();
    }
  });

  it("farklı çalışma alanları: kişisel ve şirket relay'leri birbirinin koruma durumunu etkilemez", async () => {
    clock.t = T0;
    const email = "ayni.kisi@ornek.com.tr";
    const p = await register(personal, email);
    const b = await register(business, email);
    // Her kurulumun kendi TOTP sırrı vardır.
    expect(Buffer.from(p.secret).equals(Buffer.from(b.secret))).toBe(false);
    await personal.login(email, PASSWORD, totp(p.secret, clock.t));
    // Kişisel relay'de tüketilen adım, şirket relay'indeki girişi engellemez.
    await business.login(email, PASSWORD, totp(b.secret, clock.t));
    expect(await personal.totpLastStep(p.accountId)).toBe(totpStep(T0));
    expect(await business.totpLastStep(b.accountId)).toBe(totpStep(T0));
    // Her iki tarafta da tekrar kullanım reddedilir.
    await expectMfaRejected(personal.login(email, PASSWORD, totp(p.secret, clock.t)));
    await expectMfaRejected(business.login(email, PASSWORD, totp(b.secret, clock.t)));
  });

  it("aynı relay'deki hesaplar bağımsızdır: bir hesabın tükettiği adım diğerini etkilemez", async () => {
    clock.t = T0;
    const a = await register();
    const b = await register();
    await personal.login(a.email, PASSWORD, totp(a.secret, clock.t));
    await personal.login(b.email, PASSWORD, totp(b.secret, clock.t));
    expect(await personal.totpLastStep(a.accountId)).toBe(totpStep(T0));
    expect(await personal.totpLastStep(b.accountId)).toBe(totpStep(T0));
  });

  it("tekrar kullanım denemeleri kilitlenme sayacına eklenir", async () => {
    clock.t = T0;
    const strict = makeAccounts(personalPool, "relay-personal", { maxFailures: 3 });
    const u = await register(strict);
    const code = totp(u.secret, clock.t);
    await strict.login(u.email, PASSWORD, code);
    for (let i = 0; i < 3; i++) await expectMfaRejected(strict.login(u.email, PASSWORD, code));
    // Hesap kilitli: bir sonraki adımın geçerli kodu bile kabul edilmez.
    clock.t = T0 + STEP_MS;
    await expect(strict.login(u.email, PASSWORD, totp(u.secret, clock.t))).rejects.toSatisfy((e: unknown) => e instanceof AuthError && e.code === "LOCKED");
    expect(await auditActions(personalPool, u.accountId)).toEqual(["account.registered", "login.ok", "login.totp_replay", "login.totp_replay", "login.locked"]);
  });

  it("şema dosyaları idempotenttir: art arda ve eşzamanlı çalıştırma hata vermez", async () => {
    await Promise.all([migrate(businessPool), migrate(businessPool), migrate(businessPool)]);
    const r = await businessPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'totp_last_step'",
    );
    expect(r.rows[0]?.n).toBe("1");
  });
});
