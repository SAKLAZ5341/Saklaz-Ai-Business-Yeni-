/**
 * Sprint 3 A2 — relay açılışı, yapılandırma, şema yönetimi ve veritabanı kopmasından toparlanma.
 * Docker'a bağlı olmayan kısımlar burada (her CI çalışmasında). Konteyner düzeyindeki testler
 * infra/relay/test/docker.test.ts dosyasındadır.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { initCrypto } from "@saklaz/crypto";
import {
  Accounts,
  buildRelay,
  canDecryptSecret,
  ConfigError,
  createPool,
  ensureMfaKey,
  FORBIDDEN_SECRET_ENV,
  isDbUnavailable,
  loadConfig,
  loadJwtKeys,
  migrate,
  MIGRATIONS,
  MigrationError,
  mfaKeyCheck,
  pingDb,
  RecordingPush,
  StartupError,
  totp,
  waitForDb,
  type Pool,
} from "../src/index.js";
import { createLogger, describeError, runMigrate, runServer } from "../src/run.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const HAS_PG = pgAvailable();
const RELAY_DIR = join(fileURLToPath(import.meta.url), "..", "..");
const MIGRATIONS_DIR = join(RELAY_DIR, "migrations");

function expectConfigError(fn: () => unknown, code: string, setting?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).code).toBe(code);
    if (setting) expect((e as ConfigError).setting).toContain(setting);
    return e as ConfigError;
  }
  throw new Error(`ConfigError ${code} bekleniyordu`);
}

describe("yapılandırma ve gizli bilgiler (loadConfig)", () => {
  const MFA = "ab".repeat(32);
  const files: Record<string, string> = {
    "/s/db": "postgresql://u:p@db/x",
    "/s/dbpw": "p@ss:/wörd#?\n",
    "/s/jwt": "PRIVATE-PEM",
    "/s/jwtpub": "PUBLIC-PEM",
    "/s/mfa": `${MFA}\n`,
    "/s/empty": "  \n",
    "/s/badmfa": "zz",
  };
  const read = (p: string) => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error("yok"), { code: "ENOENT" });
    if (p === "/s/noperm") throw Object.assign(new Error("izin"), { code: "EACCES" });
    return v;
  };
  const base = {
    SAKLAZ_RELAY_ID: "saklaz-personal",
    SAKLAZ_DATABASE_URL_FILE: "/s/db",
    SAKLAZ_JWT_PRIVATE_KEY_FILE: "/s/jwt",
    SAKLAZ_JWT_PUBLIC_KEY_FILE: "/s/jwtpub",
    SAKLAZ_MFA_KEY_FILE: "/s/mfa",
  };

  it("geçerli yapılandırma; varsayılanlar güvenli (proxy'ye güven yok, migrate=apply)", () => {
    const c = loadConfig(base, read);
    expect(c.relayId).toBe("saklaz-personal");
    expect(c.secrets.databaseUrl).toBe("postgresql://u:p@db/x");
    expect(Buffer.from(c.secrets.mfaKey).toString("hex")).toBe(MFA);
    expect(c.trustProxyHops).toBe(0);
    expect(c.migrateMode).toBe("apply");
    expect(c.port).toBe(8080);
  });

  it("ortam değişkeninde düz gizli değer varsa relay başlamaz (her yasaklı ad için)", () => {
    for (const k of FORBIDDEN_SECRET_ENV) {
      const e = expectConfigError(() => loadConfig({ ...base, [k]: "gizli-deger-123" }, read), "SECRET_IN_ENV", k);
      expect(e.message).not.toContain("gizli-deger-123");
    }
  });

  it("eksik, okunamayan ve boş gizli dosyalar ayrı kodlarla reddedilir; mesajda içerik yok", () => {
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_MFA_KEY_FILE: undefined }, read), "SECRET_FILE_MISSING", "SAKLAZ_MFA_KEY_FILE");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_MFA_KEY_FILE: "/s/yok" }, read), "SECRET_FILE_MISSING", "SAKLAZ_MFA_KEY_FILE");
    files["/s/noperm"] = "x";
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_JWT_PRIVATE_KEY_FILE: "/s/noperm" }, read), "SECRET_FILE_UNREADABLE", "SAKLAZ_JWT_PRIVATE_KEY_FILE");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_JWT_PUBLIC_KEY_FILE: "/s/empty" }, read), "SECRET_EMPTY", "SAKLAZ_JWT_PUBLIC_KEY_FILE");
    const e = expectConfigError(() => loadConfig({ ...base, SAKLAZ_MFA_KEY_FILE: "/s/badmfa" }, read), "MFA_KEY_INVALID");
    expect(e.message).not.toContain("zz");
  });

  it("veritabanı: parça parça yapılandırmada parola URL'de kodlanır; iki yöntem birden veya hiçbiri reddedilir", () => {
    const parts = { ...base, SAKLAZ_DATABASE_URL_FILE: undefined, SAKLAZ_DB_PASSWORD_FILE: "/s/dbpw", SAKLAZ_DB_HOST: "db", SAKLAZ_DB_USER: "saklaz", SAKLAZ_DB_NAME: "saklaz" };
    const c = loadConfig(parts, read);
    const u = new URL(c.secrets.databaseUrl);
    expect(decodeURIComponent(u.password)).toBe("p@ss:/wörd#?");
    expect(u.hostname).toBe("db");
    expect(u.pathname).toBe("/saklaz");
    expectConfigError(() => loadConfig({ ...parts, SAKLAZ_DATABASE_URL_FILE: "/s/db" }, read), "DB_CONFIG_AMBIGUOUS");
    expectConfigError(() => loadConfig({ ...parts, SAKLAZ_DB_PASSWORD_FILE: undefined }, read), "DB_CONFIG_MISSING");
    expectConfigError(() => loadConfig({ ...parts, SAKLAZ_DB_HOST: "db;drop" }, read), "SETTING_INVALID", "SAKLAZ_DB_HOST");
  });

  it("relay kimliği ve sayısal/seçenekli ayarlar doğrulanır", () => {
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_RELAY_ID: undefined }, read), "RELAY_ID_INVALID");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_RELAY_ID: "Büyük Harf" }, read), "RELAY_ID_INVALID");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_PORT: "70000" }, read), "SETTING_INVALID", "SAKLAZ_PORT");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_PORT: "80a" }, read), "SETTING_INVALID", "SAKLAZ_PORT");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_TRUST_PROXY_HOPS: "9" }, read), "SETTING_INVALID");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_MIGRATE: "force" }, read), "SETTING_INVALID", "SAKLAZ_MIGRATE");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_LOG_LEVEL: "trace" }, read), "SETTING_INVALID");
    expectConfigError(() => loadConfig({ ...base, SAKLAZ_LISTEN_HOST: "evil host" }, read), "SETTING_INVALID");
    const c = loadConfig({ ...base, SAKLAZ_TRUST_PROXY_HOPS: "1", SAKLAZ_MIGRATE: "check", SAKLAZ_PORT: "9000", SAKLAZ_LOG_LEVEL: "warn" }, read);
    expect([c.trustProxyHops, c.migrateMode, c.port, c.logLevel]).toEqual([1, "check", 9000, "warn"]);
  });
});

describe("JWT anahtar çifti denetimi", () => {
  it("geçersiz PEM ve birbirine ait olmayan çift reddedilir; mesajda anahtar içeriği yok", async () => {
    const a = await generateKeyPair("EdDSA", { extractable: true });
    const b = await generateKeyPair("EdDSA", { extractable: true });
    const aPriv = await exportPKCS8(a.privateKey);
    const aPub = await exportSPKI(a.publicKey);
    const bPub = await exportSPKI(b.publicKey);
    await expect(loadJwtKeys(aPriv, aPub, "saklaz-personal")).resolves.toBeDefined();
    await expect(loadJwtKeys(aPriv, bPub, "saklaz-personal")).rejects.toSatisfy((e: unknown) => e instanceof StartupError && e.code === "JWT_KEYPAIR_MISMATCH");
    const bad = loadJwtKeys("-----BEGIN PRIVATE KEY-----\nGIZLIICERIK\n-----END PRIVATE KEY-----", aPub, "x");
    await expect(bad).rejects.toSatisfy((e: unknown) => e instanceof StartupError && e.code === "JWT_KEY_INVALID" && !e.message.includes("GIZLIICERIK"));
  });
});

describe("veritabanı hata sınıflandırması", () => {
  it("bağlantı hataları 'kullanılamıyor' sayılır, diğerleri sayılmaz", () => {
    expect(isDbUnavailable({ code: "ECONNREFUSED" })).toBe(true);
    expect(isDbUnavailable({ code: "57P01" })).toBe(true);
    expect(isDbUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDbUnavailable({ code: "23505" })).toBe(false);
    expect(isDbUnavailable(new Error("başka"))).toBe(false);
    expect(isDbUnavailable(null)).toBe(false);
  });
});

/** Veritabanının önüne konan, istenince kesilip yeniden açılan TCP vekili (kopma benzetimi). */
class FlakyProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  port = 0;
  constructor(private readonly target: { host?: string; port?: number; path?: string }) {}
  async start(port = 0): Promise<void> {
    this.server = createServer((client) => {
      const upstream = this.target.path ? connect(this.target.path) : connect(this.target.port ?? 5432, this.target.host ?? "127.0.0.1");
      this.sockets.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", drop).on("close", drop).pipe(upstream);
      upstream.on("error", drop).on("close", drop).pipe(client);
    });
    await new Promise<void>((r) => this.server?.listen(port, "127.0.0.1", r));
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("adres yok");
    this.port = a.port;
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

/**
 * Test PostgreSQL adresini çözümler. İki biçim desteklenir: TCP (CI servisi) ve Unix soketi
 * (yerel geçici küme: "postgresql://postgres@/db?host=/soket/klasoru"; URL sınıfı bunu ayrıştıramaz).
 */
function parsePgUrl(url: string): { creds: string; db: string; target: { host?: string; port?: number; path?: string } } {
  const m = /^postgres(?:ql)?:\/\/([^@/]*)@([^/]*)\/([^?]*)(?:\?(.*))?$/.exec(url);
  if (!m) throw new Error("test PostgreSQL adresi çözümlenemedi");
  const [, creds = "", hostport = "", db = "", query = ""] = m;
  const socketDir = new URLSearchParams(query).get("host");
  if (socketDir) return { creds, db, target: { path: join(socketDir, ".s.PGSQL.5432") } };
  const [host, port] = hostport.split(":");
  return { creds, db, target: { host: host === "localhost" || !host ? "127.0.0.1" : host, port: Number(port ?? "5432") } };
}

/** Aynı sunucuda başka bir veritabanının adresi. */
function withDb(url: string, name: string): string {
  const m = /^(postgres(?:ql)?:\/\/[^@/]*@[^/]*\/)([^?]*)(\?.*)?$/.exec(url);
  if (!m) throw new Error("test PostgreSQL adresi çözümlenemedi");
  return `${m[1] ?? ""}${name}${m[3] ?? ""}`;
}

describe.skipIf(!HAS_PG)("açılış ve şema (gerçek PostgreSQL)", () => {
  let pgi: TestPg;
  let pool: Pool;
  const mfaKey = randomBytes(32);

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    pool = createPool(pgi.url);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await pgi.stop();
  });

  it("migration: ilk kurulum hepsini uygular ve özetleriyle kaydeder; ikinci çalıştırma hiçbir şey uygulamaz", async () => {
    const first = await migrate(pool);
    expect(first.applied).toEqual([...MIGRATIONS]);
    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([...MIGRATIONS]);
    const r = await pool.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations ORDER BY name");
    expect(r.rows.map((x) => x.name)).toEqual([...MIGRATIONS]);
    for (const row of r.rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    // check modu: her şey uygulanmışsa sorun yok.
    await expect(migrate(pool, { mode: "check" })).resolves.toBeDefined();
  });

  describe("migration denetimleri (geçici şema klasörüyle)", () => {
    let dir: string;
    let tmpPool: Pool;
    let dbName: string;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "saklaz-mig-"));
      dbName = `saklaz_mig_${randomBytes(4).toString("hex")}`;
      await pool.query(`CREATE DATABASE ${dbName}`);
      tmpPool = createPool(withDb(pgi.url, dbName));
    });
    afterAll(async () => {
      await tmpPool.end();
      await pool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    });
    const dirUrl = () => pathToFileURL(`${dir}/`);

    it("check modunda bekleyen dosya varsa hiçbir şey değiştirilmez ve hata verilir", async () => {
      writeFileSync(join(dir, "a.sql"), "CREATE TABLE IF NOT EXISTS t1 (x int);");
      await expect(migrate(tmpPool, { files: ["a.sql"], dir: dirUrl(), mode: "check" })).rejects.toSatisfy(
        (e: unknown) => e instanceof MigrationError && e.code === "MIGRATION_PENDING" && e.file === "a.sql",
      );
      const t = await tmpPool.query("SELECT to_regclass('t1') AS t");
      expect((t.rows[0] as { t: unknown }).t).toBeNull();
      await migrate(tmpPool, { files: ["a.sql"], dir: dirUrl() });
    });

    it("uygulanmış bir dosyanın içeriği değişirse relay başlamaz (MIGRATION_MODIFIED)", async () => {
      writeFileSync(join(dir, "a.sql"), "CREATE TABLE IF NOT EXISTS t1 (x int); -- kurcalandı");
      await expect(migrate(tmpPool, { files: ["a.sql"], dir: dirUrl() })).rejects.toSatisfy(
        (e: unknown) => e instanceof MigrationError && e.code === "MIGRATION_MODIFIED",
      );
      writeFileSync(join(dir, "a.sql"), "CREATE TABLE IF NOT EXISTS t1 (x int);");
    });

    it("veritabanında olup bu sürümde bulunmayan dosya varsa (eski imaj) relay başlamaz (MIGRATION_UNKNOWN)", async () => {
      await expect(migrate(tmpPool, { files: [], dir: dirUrl() })).rejects.toSatisfy(
        (e: unknown) => e instanceof MigrationError && e.code === "MIGRATION_UNKNOWN" && e.file === "a.sql",
      );
    });

    it("hatalı bir dosya yarıda kalırsa geri alınır ve kayda geçmez; düzeltilince uygulanır", async () => {
      writeFileSync(join(dir, "b.sql"), "CREATE TABLE t2 (x int); SELECT * FROM olmayan_tablo;");
      await expect(migrate(tmpPool, { files: ["a.sql", "b.sql"], dir: dirUrl() })).rejects.toBeDefined();
      const t = await tmpPool.query("SELECT to_regclass('t2') AS t");
      expect((t.rows[0] as { t: unknown }).t).toBeNull();
      writeFileSync(join(dir, "b.sql"), "CREATE TABLE IF NOT EXISTS t2 (x int);");
      const r = await migrate(tmpPool, { files: ["a.sql", "b.sql"], dir: dirUrl() });
      expect(r.applied).toEqual(["b.sql"]);
    });

    it("Sprint 2/A1 döneminde (kayıt tablosu olmadan) kurulmuş veritabanı güvenle güncellenir; veri korunur", async () => {
      const legacyDb = `saklaz_legacy_${randomBytes(4).toString("hex")}`;
      await pool.query(`CREATE DATABASE ${legacyDb}`);
      const lp = createPool(withDb(pgi.url, legacyDb));
      try {
        // A1 dönemi: dosyalar kayıt tablosu olmadan doğrudan çalıştırılıyordu.
        const { readFileSync } = await import("node:fs");
        for (const f of ["001_init.sql", "002_totp_replay.sql"]) await lp.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
        await lp.query("INSERT INTO accounts (id, email, password_hash, totp_secret_enc, totp_last_step) VALUES (gen_random_uuid(), 'eski@ornek.com.tr', 'x', '\\x00', 42)");
        const r = await migrate(lp);
        expect(r.applied).toEqual([...MIGRATIONS]);
        const kept = await lp.query<{ totp_last_step: string }>("SELECT totp_last_step FROM accounts WHERE email = 'eski@ornek.com.tr'");
        expect(kept.rows[0]?.totp_last_step).toBe("42");
      } finally {
        await lp.end();
        await pool.query(`DROP DATABASE IF EXISTS ${legacyDb} WITH (FORCE)`);
      }
    });
  });

  it("MFA anahtarı: ilk açılışta denetim değeri kaydedilir; aynı anahtar doğrulanır; farklı anahtar reddedilir", async () => {
    await migrate(pool);
    await pool.query("DELETE FROM relay_meta");
    const can = (k: Uint8Array) => (blob: Buffer) => canDecryptSecret(k, blob);
    expect(await ensureMfaKey(pool, mfaKey, can(mfaKey))).toBe("initialized");
    expect(await ensureMfaKey(pool, mfaKey, can(mfaKey))).toBe("verified");
    const other = randomBytes(32);
    await expect(ensureMfaKey(pool, other, can(other))).rejects.toSatisfy((e: unknown) => e instanceof StartupError && e.code === "MFA_KEY_MISMATCH");
    // Kayıtlı değer anahtarın kendisi değildir.
    const v = await pool.query<{ value: string }>("SELECT value FROM relay_meta WHERE key = 'mfa_key_check'");
    expect(v.rows[0]?.value).toBe(mfaKeyCheck(mfaKey));
    expect(v.rows[0]?.value).not.toContain(Buffer.from(mfaKey).toString("hex"));
  });

  it("MFA anahtarı: denetim değeri olmayan eski kurulumda, hesap sırlarını çözemeyen anahtar reddedilir", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const acc = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey, issuer: "saklaz-personal" });
    await acc.register("mfa-eski@ornek.com.tr", "çok-gizli-parola-123");
    await pool.query("DELETE FROM relay_meta");
    const wrong = randomBytes(32);
    await expect(ensureMfaKey(pool, wrong, (b) => canDecryptSecret(wrong, b))).rejects.toSatisfy(
      (e: unknown) => e instanceof StartupError && e.code === "MFA_KEY_MISMATCH",
    );
    expect(await ensureMfaKey(pool, mfaKey, (b) => canDecryptSecret(mfaKey, b))).toBe("initialized");
  });

  it("veritabanını bekleme: ulaşılamazsa süre sonunda DB_UNREACHABLE; ulaşılabiliyorsa hemen döner", async () => {
    await expect(waitForDb(pool, { maxWaitMs: 1000 })).resolves.toBeUndefined();
    const dead = createPool("postgresql://u:gizliparola@127.0.0.1:1/x");
    const retries: number[] = [];
    try {
      await expect(waitForDb(dead, { maxWaitMs: 400, onRetry: (a) => retries.push(a), sleep: () => Promise.resolve() })).rejects.toSatisfy(
        (e: unknown) => e instanceof StartupError && e.code === "DB_UNREACHABLE" && !e.message.includes("gizliparola"),
      );
      expect(retries.length).toBeGreaterThan(0);
    } finally {
      await dead.end();
    }
  });

  it("veritabanı bağlantısı koparsa: süreç çökmez, /readyz 503, istekler ayrıntısız 503; bağlantı gelince kendiliğinden toparlanır", async () => {
    const { creds, db, target } = parsePgUrl(pgi.url);
    const proxy = new FlakyProxy(target);
    await proxy.start();
    const idleErrors: Error[] = [];
    const p2 = createPool(`postgresql://${creds}@127.0.0.1:${proxy.port}/${db}`, { onIdleError: (e) => idleErrors.push(e) });
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const clock = { t: 1_794_000_015_000 };
    const acc = new Accounts(p2, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey, issuer: "saklaz-personal", now: () => clock.t });
    const { app } = buildRelay({ pool: p2, accounts: acc, relayId: "saklaz-personal", push: new RecordingPush(), now: () => clock.t, authRatePerMinute: 1000, ready: () => pingDb(p2, 1000) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("adres yok");
    const base = `http://127.0.0.1:${addr.port}`;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    };
    try {
      const reg = await post("/v1/accounts", { email: "kopma@ornek.com.tr", password: "çok-gizli-parola-123" });
      expect(reg.status).toBe(201);
      const secret = new URL((JSON.parse(reg.text) as { otpauth: string }).otpauth).searchParams.get("secret") ?? "";
      expect((await fetch(`${base}/readyz`)).status).toBe(200);

      // Kopma: vekil kapatılır, mevcut bağlantılar kesilir.
      await proxy.stop();
      await new Promise((r) => setTimeout(r, 100));
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/healthz`)).status).toBe(200); // süreç canlı
      const down = await post("/v1/auth/login", { email: "kopma@ornek.com.tr", password: "çok-gizli-parola-123", code: "123456" });
      expect(down.status).toBe(503);
      expect(JSON.parse(down.text)).toEqual({ error: "UNAVAILABLE" });
      expect(down.text).not.toMatch(/127\.0\.0\.1|ECONN|postgres|password/i);

      // Toparlanma: aynı portta vekil yeniden açılır.
      const proxy2 = new FlakyProxy(target);
      await proxy2.start(proxy.port);
      try {
        let ok = false;
        for (let i = 0; i < 20 && !ok; i++) {
          ok = (await fetch(`${base}/readyz`)).status === 200;
          if (!ok) await new Promise((r) => setTimeout(r, 100));
        }
        expect(ok).toBe(true);
        // Base32 çözümü
        const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = 0;
        let val = 0;
        const out: number[] = [];
        for (const ch of secret) {
          val = (val << 5) | A.indexOf(ch);
          bits += 5;
          if (bits >= 8) {
            out.push((val >>> (bits - 8)) & 255);
            bits -= 8;
          }
        }
        const login = await post("/v1/auth/login", { email: "kopma@ornek.com.tr", password: "çok-gizli-parola-123", code: totp(Uint8Array.from(out), clock.t) });
        expect(login.status).toBe(200);
      } finally {
        await app.close();
        await p2.end();
        await proxy2.stop();
      }
    } finally {
      await proxy.stop().catch(() => undefined);
    }
  });
});


describe("günlükçü ve hata açıklaması (run.ts)", () => {
  it("seviye filtresi; JSON satır; hata açıklaması yalnızca ad ve kod içerir", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log("debug", "görünmez");
    log("info", "görünür", { a: 1 });
    log.setLevel("error");
    log("warn", "görünmez");
    log("error", "hata");
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["görünür", "hata"]);
    expect(describeError(Object.assign(new Error("postgresql://u:GIZLI@db/x bağlanamadı"), { code: "ECONNREFUSED" }))).toEqual({ error: "Error", code: "ECONNREFUSED" });
    expect(describeError(null)).toEqual({ error: "Error", code: null });
    expect(describeError({ name: 5 })).toEqual({ error: "Error", code: null });
    expect(describeError(new ConfigError("SECRET_EMPTY", "X"))["code"]).toBe("SECRET_EMPTY");
  });
});

describe.skipIf(!HAS_PG)("relay açılışı süreç içinde (run.ts, gerçek PostgreSQL)", () => {
  let pgi: TestPg;
  let admin: Pool;
  let dir: string;
  const key = randomBytes(32).toString("hex");
  let n = 0;

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    admin = createPool(pgi.url);
    dir = mkdtempSync(join(tmpdir(), "saklaz-run-"));
    const kp = await generateKeyPair("EdDSA", { extractable: true });
    writeFileSync(join(dir, "jwt"), await exportPKCS8(kp.privateKey));
    writeFileSync(join(dir, "jwtpub"), await exportSPKI(kp.publicKey));
    writeFileSync(join(dir, "mfa"), key);
    writeFileSync(join(dir, "mfa-wrong"), randomBytes(32).toString("hex"));
  }, 60_000);

  afterAll(async () => {
    await admin.end();
    await pgi.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function freshDb(): Promise<string> {
    const name = `saklaz_run_${++n}_${randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const f = join(dir, `${name}.url`);
    writeFileSync(f, withDb(pgi.url, name));
    return f;
  }

  const envFor = (dbFile: string, extra: Record<string, string> = {}) => ({
    SAKLAZ_RELAY_ID: "saklaz-personal",
    SAKLAZ_DATABASE_URL_FILE: dbFile,
    SAKLAZ_JWT_PRIVATE_KEY_FILE: join(dir, "jwt"),
    SAKLAZ_JWT_PUBLIC_KEY_FILE: join(dir, "jwtpub"),
    SAKLAZ_MFA_KEY_FILE: join(dir, "mfa"),
    SAKLAZ_LISTEN_HOST: "127.0.0.1",
    SAKLAZ_PORT: "0",
    ...extra,
  });

  function capture() {
    const lines: string[] = [];
    return { log: createLogger((l) => lines.push(l)), text: () => lines.join("") };
  }

  it("başarılı açılış: şema, anahtar denetimi, dinleme; /healthz ve /readyz; düzgün kapanma (iki kez çağrılabilir)", async () => {
    const db = await freshDb();
    const c = capture();
    const relay = await runServer(envFor(db, { SAKLAZ_TRUST_PROXY_HOPS: "1", SAKLAZ_LOG_LEVEL: "debug" }), c.log);
    try {
      expect(relay.port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${relay.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${relay.port}/readyz`)).status).toBe(200);
      expect(c.text()).toContain('"mfaKeyCheck":"initialized"');
      expect(c.text()).toContain("relay dinliyor");
    } finally {
      await relay.stop();
      await relay.stop();
    }
    // İkinci açılış: anahtar doğrulanır, şema yeniden uygulanmaz.
    const c2 = capture();
    const again = await runServer(envFor(db), c2.log);
    await again.stop();
    expect(c2.text()).toContain('"mfaKeyCheck":"verified"');
    expect(c2.text()).toContain('"applied":"-"');
    for (const t of [c.text(), c2.text()]) expect(t).not.toContain(key);
  });

  it("yanlış MFA anahtarıyla açılış reddedilir; check modunda bekleyen şema varsa açılmaz; migrate komutu şemayı uygular", async () => {
    const db = await freshDb();
    const c = capture();
    await expect(runServer(envFor(db, { SAKLAZ_MIGRATE: "check" }), c.log)).rejects.toSatisfy(
      (e: unknown) => e instanceof MigrationError && e.code === "MIGRATION_PENDING",
    );
    await runMigrate(envFor(db), c.log);
    expect(c.text()).toContain("003_relay_meta.sql");
    const ok1 = await runServer(envFor(db, { SAKLAZ_MIGRATE: "check" }), c.log);
    await ok1.stop();
    await expect(runServer(envFor(db, { SAKLAZ_MFA_KEY_FILE: join(dir, "mfa-wrong") }), c.log)).rejects.toSatisfy(
      (e: unknown) => e instanceof StartupError && e.code === "MFA_KEY_MISMATCH",
    );
    expect(c.text()).not.toContain(key);
  });

  it("veritabanına ulaşılamazsa süre sonunda DB_UNREACHABLE; bağlantı adresi ve parola günlükte yok", async () => {
    const f = join(dir, "dead.url");
    writeFileSync(f, "postgresql://saklaz:COKGIZLIPAROLA@127.0.0.1:1/saklaz");
    const c = capture();
    await expect(runServer(envFor(f, { SAKLAZ_DB_WAIT_MS: "300" }), c.log)).rejects.toSatisfy(
      (e: unknown) => e instanceof StartupError && e.code === "DB_UNREACHABLE",
    );
    await expect(runMigrate(envFor(f, { SAKLAZ_DB_WAIT_MS: "0" }), c.log)).rejects.toBeInstanceOf(StartupError);
    expect(c.text()).toContain("veritabanı bekleniyor");
    expect(c.text()).not.toContain("COKGIZLIPAROLA");
  });
});

describe("relay süreci (giriş noktası, ayrı süreç)", () => {
  /** src/main.ts'i ayrı bir Node sürecinde çalıştırır; çıkış kodu ve günlük satırlarını döndürür. */
  function runMain(env: Record<string, string>, args: string[] = [], ms = 20_000): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", join(RELAY_DIR, "src", "main.ts"), ...args], {
        cwd: RELAY_DIR,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
      const t = setTimeout(() => child.kill("SIGKILL"), ms);
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    });
  }

  it("eksik gizli dosya, ortamda gizli değer ve bilinmeyen komut: çıkış kodu ≠ 0, JSON günlük, gizli değer yok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saklaz-sec-"));
    chmodSync(dir, 0o700);
    const key = randomBytes(32).toString("hex");
    writeFileSync(join(dir, "mfa"), key);
    try {
      const env = { SAKLAZ_RELAY_ID: "saklaz-personal", SAKLAZ_MFA_KEY_FILE: join(dir, "mfa") };
      const missing = await runMain(env);
      expect(missing.code).toBe(1);
      const line = JSON.parse(missing.out.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
      expect(line["level"]).toBe("fatal");
      expect(line["code"]).toBe("DB_CONFIG_MISSING");

      const inEnv = await runMain({ ...env, SAKLAZ_DB_PASSWORD: "parola-ortamda-olmamali" });
      expect(inEnv.code).toBe(1);
      expect(inEnv.out).toContain("SECRET_IN_ENV");
      expect(inEnv.out).not.toContain("parola-ortamda-olmamali");

      const unknown = await runMain(env, ["bilinmeyen"]);
      expect(unknown.code).toBe(2);

      for (const r of [missing, inEnv, unknown]) expect(r.out).not.toContain(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!HAS_PG)("tam açılış, yanlış MFA anahtarıyla yeniden açılış reddi ve SIGTERM ile düzgün kapanma", async () => {
    const pgx = await startPg();
    const dir = mkdtempSync(join(tmpdir(), "saklaz-sec-"));
    try {
      const kp = await generateKeyPair("EdDSA", { extractable: true });
      writeFileSync(join(dir, "db"), pgx.url);
      writeFileSync(join(dir, "jwt"), await exportPKCS8(kp.privateKey));
      writeFileSync(join(dir, "jwtpub"), await exportSPKI(kp.publicKey));
      const key = randomBytes(32).toString("hex");
      writeFileSync(join(dir, "mfa"), key);
      writeFileSync(join(dir, "mfa-wrong"), randomBytes(32).toString("hex"));
      const env = {
        SAKLAZ_RELAY_ID: "saklaz-personal",
        SAKLAZ_DATABASE_URL_FILE: join(dir, "db"),
        SAKLAZ_JWT_PRIVATE_KEY_FILE: join(dir, "jwt"),
        SAKLAZ_JWT_PUBLIC_KEY_FILE: join(dir, "jwtpub"),
        SAKLAZ_MFA_KEY_FILE: join(dir, "mfa"),
        SAKLAZ_LISTEN_HOST: "127.0.0.1",
        SAKLAZ_PORT: "0",
      };
      // migrate komutu: şemayı uygular ve 0 ile çıkar.
      const m = await runMain(env, ["migrate"]);
      expect(m.code).toBe(0);
      expect(m.out).toContain("003_relay_meta.sql");

      // Sunucu: açılır, dinler; SIGTERM ile düzgün kapanır.
      const child = spawn(process.execPath, ["--import", "tsx", join(RELAY_DIR, "src", "main.ts")], {
        cwd: RELAY_DIR,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
      for (let i = 0; i < 100 && !out.includes("relay dinliyor"); i++) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain("relay dinliyor");
      expect(out).toContain('"mfaKeyCheck":"initialized"');
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(out).toContain("kapandı");

      // Yanlış MFA anahtarıyla yeniden açılış: başlamaz.
      const wrong = await runMain({ ...env, SAKLAZ_MFA_KEY_FILE: join(dir, "mfa-wrong") });
      expect(wrong.code).toBe(1);
      expect(wrong.out).toContain("MFA_KEY_MISMATCH");
      expect(wrong.out).not.toContain("relay dinliyor");

      for (const r of [m, wrong]) {
        expect(r.out).not.toContain(key);
        expect(r.out).not.toContain(pgx.url);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pgx.stop();
    }
  });
});
