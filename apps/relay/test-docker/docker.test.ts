/**
 * Sprint 3 A2 — Docker / Compose entegrasyon testleri (gerçek imaj, gerçek PostgreSQL konteyneri,
 * gerçek Caddy TLS). Yalnızca SAKLAZ_DOCKER_TEST=1 iken ve Docker erişilebilirken çalışır (CI'daki
 * "Docker" işi). Normal test paketine dahil değildir (vitest.docker.config.ts).
 *
 * Gerekenler: docker + compose v2, openssl, pgrep, parolasız sudo (gizli dosya sahipliği ve
 * süreç öldürme için), önceden derlenmiş imaj (SAKLAZ_RELAY_IMAGE).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hotp, totpStep } from "../src/totp.js";

const ENABLED = process.env["SAKLAZ_DOCKER_TEST"] === "1";
// İmaj adı ortam değişkeninden ALINMAZ: komut satırına giden değerler dışarıdan denetlenemesin
// (CodeQL js/indirect-command-line-injection). CI bu etiketle derler (.github/workflows/ci.yml).
const IMAGE = "saklaz-relay:test";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMPOSE_FILE = join(ROOT, "infra", "relay", "docker-compose.yml");
const INIT_SECRETS = join(ROOT, "infra", "relay", "scripts", "init-secrets.sh");
/**
 * Komutlara (docker, sudo) parametre olarak giden yollar yalnızca bu kalıba uyabilir: mutlak,
 * boşluksuz, kabuk özel karakteri içermeyen. Uymazsa test hiç çalışmaz.
 */
function safePath(p: string, what: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(p) || p.includes("..")) throw new Error(`güvensiz yol (${what})`);
  return p;
}
const LOG_DIR = safePath(process.env["SAKLAZ_DOCKER_LOG_DIR"] ?? join(tmpdir(), "saklaz-docker-logs"), "SAKLAZ_DOCKER_LOG_DIR");
const PASSWORD = "çok-gizli-parola-docker-123";

// ───────────────────────── yardımcılar ─────────────────────────

function run(cmd: string, args: string[], o: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    env: { ...process.env, ...o.env },
    input: o.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: o.timeoutMs ?? 300_000,
  });
}

function ok(r: SpawnSyncReturns<string>, what: string): string {
  if (r.status !== 0) throw new Error(`${what} başarısız (çıkış ${String(r.status)}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const asRoot = process.getuid?.() === 0;
const sudo = (args: string[], o: { input?: string } = {}) => (asRoot ? run(args[0] ?? "true", args.slice(1), o) : run("sudo", ["-n", ...args], o));

interface Workspace {
  project: string;
  relayId: string;
  port: number;
  secretsDir: string;
  ca?: string;
}

function composeEnv(w: Workspace, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SAKLAZ_RELAY_IMAGE: IMAGE,
    SAKLAZ_RELAY_DOMAIN: "localhost",
    SAKLAZ_RELAY_ID: w.relayId,
    SAKLAZ_SECRETS_DIR: w.secretsDir,
    SAKLAZ_HTTPS_PORT: String(w.port),
    SAKLAZ_HTTPS_BIND: "127.0.0.1",
    ...extra,
  };
}

function compose(w: Workspace, args: string[], extra: Record<string, string> = {}, timeoutMs = 300_000) {
  return run("docker", ["compose", "-f", COMPOSE_FILE, "-p", w.project, ...args], { env: composeEnv(w, extra), timeoutMs });
}

function containerId(w: Workspace, service: string): string {
  return ok(compose(w, ["ps", "-q", "--all", service]), `${service} kimliği`).trim();
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- çağıran, docker inspect alanının biçimini bildirir
function inspect<T>(id: string, format: string): T {
  return JSON.parse(ok(run("docker", ["inspect", "-f", `{{json ${format}}}`, id]), "docker inspect").trim()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 120_000, stepMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (pred(last)) return last;
    } catch {
      // yeniden dene
    }
    await sleep(stepMs);
  }
  throw new Error(`zaman aşımı: ${what} (son değer: ${JSON.stringify(last)})`);
}

interface ApiResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  raw: string;
}

function api(w: Workspace, method: string, path: string, body?: unknown, token?: string): Promise<ApiResult> {
  if (!w.ca) throw new Error("CA yok");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: w.port,
        servername: "localhost",
        ca: w.ca,
        method,
        path,
        headers: {
          host: "localhost",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (raw += d));
        res.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // gövde JSON değil
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("istek zaman aşımı")));
    if (payload) req.write(payload);
    req.end();
  });
}

function base32Decode(b32: string): Uint8Array {
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

/** Konteyner ile test süreci aynı makinenin saatini kullanır. Bir adım bir kez kullanılabilir. */
class User {
  lastStep = -1n;
  usedCodes: string[] = [];
  constructor(
    readonly email: string,
    readonly secret: Uint8Array,
  ) {}
  /** Sunucunun kabul edeceği, bu hesapta henüz kullanılmamış bir sonraki kod (gerekirse bekler). */
  async nextCode(): Promise<string> {
    for (;;) {
      const now = totpStep(Date.now());
      const step = this.lastStep + 1n > now ? this.lastStep + 1n : now;
      if (step <= now + 1n) {
        this.lastStep = step;
        const c = hotp(this.secret, step);
        this.usedCodes.push(c);
        return c;
      }
      await sleep(2_000);
    }
  }
}

async function register(w: Workspace, email: string): Promise<User> {
  const r = await api(w, "POST", "/v1/accounts", { email, password: PASSWORD });
  expect(r.status).toBe(201);
  const secret = new URL(String(r.body["otpauth"])).searchParams.get("secret") ?? "";
  secrets.push(secret);
  return new User(email, base32Decode(secret));
}

async function login(w: Workspace, u: User, code?: string) {
  return api(w, "POST", "/v1/auth/login", { email: u.email, password: PASSWORD, code: code ?? (await u.nextCode()) });
}

function psql(w: Workspace, sql: string): string {
  return ok(compose(w, ["exec", "-T", "db", "psql", "-U", "saklaz", "-d", "saklaz", "-At", "-c", sql]), "psql").trim();
}

/** Gizli dosyayı okur (dosyalar relay kullanıcısına aittir, 0400; test sudo ile okur). */
function readSecretFile(w: Workspace, name: string): string {
  return ok(sudo(["cat", join(w.secretsDir, name)]), `gizli dosya ${name}`).trim();
}

/** Günlüklerde ve imajda aranacak gizli değerler (test sonunda tarama). */
const secrets: string[] = [];
const tokens: string[] = [];

function saveLogs(w: Workspace, label: string): string {
  const logs = compose(w, ["logs", "--no-color", "--timestamps"]).stdout;
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, `${w.project}.log`), `\n===== ${label} =====\n${logs}`);
  return logs;
}

// ───────────────────────── testler ─────────────────────────

describe.skipIf(!ENABLED).sequential("relay Docker kurulumu (A2)", () => {
  const work = ENABLED ? safePath(mkdtempSync(join(tmpdir(), "saklaz-docker-")), "geçici klasör") : "";
  const personal: Workspace = { project: "saklaz-a2-personal", relayId: "saklaz-personal", port: 18443, secretsDir: join(work, "personal") };
  const business: Workspace = { project: "saklaz-a2-business", relayId: "saklaz-business", port: 18444, secretsDir: join(work, "business") };
  let alice: User;

  async function waitHealthy(w: Workspace) {
    ok(compose(w, ["up", "-d", "--no-build", "--wait", "--wait-timeout", "240"]), `${w.project} up --wait`);
    if (!w.ca) {
      const caFile = join(work, `${w.project}-root.crt`);
      await until("Caddy kök sertifikası", () => compose(w, ["cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caFile]).status, (s) => s === 0, 60_000);
      w.ca = readFileSync(caFile, "utf8");
    }
    await until("HTTPS /readyz", () => api(w, "GET", "/readyz"), (r) => r.status === 200, 120_000);
  }

  beforeAll(() => {
    ok(run("docker", ["image", "inspect", IMAGE]), `imaj ${IMAGE} bulunamadı (önce derleyin)`);
    for (const w of [personal, business]) {
      // Compose'u çalıştıran kullanıcı root değil ("docker" grubunda): klasöre yalnızca geçiş izni verilir.
      ok(sudo(["env", "SAKLAZ_SECRETS_DIR_GROUP=docker", "sh", INIT_SECRETS, w.secretsDir]), `${w.project} gizli bilgileri`);
      for (const f of ["db_password", "mfa_key.hex", "jwt_private.pem"]) {
        const v = readSecretFile(w, f);
        secrets.push(f === "jwt_private.pem" ? v.split("\n")[1] ?? v : v);
      }
    }
  });

  afterAll(() => {
    for (const w of [personal, business]) {
      try {
        saveLogs(w, "son");
      } finally {
        compose(w, ["down", "-v", "--remove-orphans"]);
      }
    }
    if (work) sudo(["rm", "-rf", work]);
  });

  it("imaj: kök olmayan kullanıcı; kaynak kod, test, derleme aracı ve paket yöneticisi yok; gizli değer yok", () => {
    expect(inspect<string>(IMAGE, ".Config.User")).toBe("node");
    const env = inspect<string[]>(IMAGE, ".Config.Env");
    for (const e of env) expect(e).not.toMatch(/PASSWORD|SECRET|PRIVATE|MFA_KEY|TOKEN/i);
    const out = ok(
      run("docker", [
        "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
        "id -u; ls -A /app | tr '\\n' ' '; echo; find /app -path /app/node_modules -prune -o -name '*.ts' -print | wc -l; ls /app/node_modules/@saklaz 2>/dev/null | wc -l; command -v npm npx corepack yarn | wc -l; grep -rl 'PRIVATE KEY' /app/dist /app/migrations /app/package.json 2>/dev/null | wc -l",
      ]),
      "imaj içeriği",
    ).trim().split("\n");
    expect(out[0]).toBe("1000");
    expect(out[1]?.trim().split(" ").sort()).toEqual(["dist", "migrations", "node_modules", "package.json"]);
    expect(out.slice(2)).toEqual(["0", "0", "0", "0"]);
    const history = ok(run("docker", ["history", "--no-trunc", "--format", "{{.CreatedBy}}", IMAGE]), "docker history");
    expect(history).not.toMatch(/secrets\/|PRIVATE KEY|mfa_key|db_password/);
  });

  it("derleme bağlamı: repoda duran gizli dosyalar imaja GİRMEZ (.dockerignore izin listesi, kanarya testi)", () => {
    const canary = `KANARYA-${randomBytes(16).toString("hex")}`;
    const files = [join(ROOT, "infra", "relay", "secrets", "mfa_key.hex"), join(ROOT, ".env"), join(ROOT, "apps", "relay", ".env")];
    for (const f of files) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, canary);
    }
    try {
      ok(run("docker", ["build", "-q", "-t", "saklaz-relay:kanarya", "-f", join(ROOT, "infra", "relay", "Dockerfile"), ROOT], { timeoutMs: 900_000 }), "kanarya derlemesi");
      const cid = ok(run("docker", ["create", "saklaz-relay:kanarya"]), "docker create").trim();
      try {
        const tar = run("docker", ["export", cid]);
        expect(tar.status).toBe(0);
        expect(tar.stdout.includes(canary)).toBe(false);
      } finally {
        run("docker", ["rm", cid]);
      }
    } finally {
      for (const f of files) rmSync(f, { force: true });
      run("docker", ["rmi", "saklaz-relay:kanarya"]);
    }
  });

  it("ilk kurulum: bütün servisler sağlıklı; relay root değil, yetkisiz, salt okunur; yalnızca HTTPS portu açık; TLS 1.3", async () => {
    await waitHealthy(personal);
    const psOut = ok(compose(personal, ["ps", "--format", "json"]), "ps").trim();
    // Compose sürümüne göre tek bir JSON dizisi veya satır başına bir nesne.
    const ps = (psOut.startsWith("[") ? JSON.parse(psOut) : psOut.split("\n").map((l) => JSON.parse(l) as unknown)) as { Service: string; Health: string; State: string }[];
    expect(ps.map((p) => p.Service).sort()).toEqual(["caddy", "db", "relay"]);
    for (const p of ps) expect([p.Service, p.State, p.Health]).toEqual([p.Service, "running", "healthy"]);

    const relayId = containerId(personal, "relay");
    const inRelay = ok(
      run("docker", ["exec", relayId, "sh", "-c", "id -u; grep CapEff /proc/self/status | tr -s '\\t ' ' '; touch /app/x 2>/dev/null && echo yazilabilir || echo salt-okunur"]),
      "relay içi denetim",
    ).trim().split("\n");
    expect(inRelay[0]).toBe("1000");
    expect(inRelay[1]).toBe("CapEff: 0000000000000000");
    expect(inRelay[2]).toBe("salt-okunur");
    expect(inspect<boolean>(relayId, ".HostConfig.ReadonlyRootfs")).toBe(true);
    expect(inspect<string>(relayId, ".HostConfig.RestartPolicy.Name")).toBe("unless-stopped");

    // Yayımlanan portlar: yalnızca Caddy 443 → 127.0.0.1:18443
    for (const svc of ["relay", "db"]) {
      const ports = inspect<Record<string, unknown[] | null>>(containerId(personal, svc), ".NetworkSettings.Ports");
      for (const v of Object.values(ports)) expect(v).toBeNull();
    }
    const caddyPorts = inspect<Record<string, { HostIp: string; HostPort: string }[] | null>>(containerId(personal, "caddy"), ".NetworkSettings.Ports");
    expect(caddyPorts["443/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: String(personal.port) }]);

    const h = await api(personal, "GET", "/healthz");
    expect(h.status).toBe(200);
    expect(String(h.headers["strict-transport-security"])).toContain("max-age=31536000");
    expect(h.headers["server"]).toBeUndefined();
    expect((await api(personal, "GET", "/baska-bir-yol")).status).toBe(404);

    const tls12 = run("openssl", ["s_client", "-connect", `127.0.0.1:${personal.port}`, "-servername", "localhost", "-tls1_2"], { input: "", timeoutMs: 20_000 });
    expect(tls12.status).not.toBe(0);
    const tls13 = run("openssl", ["s_client", "-connect", `127.0.0.1:${personal.port}`, "-servername", "localhost", "-tls1_3"], { input: "", timeoutMs: 20_000 });
    expect(tls13.stdout).toMatch(/TLSv1\.3/);

    expect(saveLogs(personal, "ilk kurulum")).toContain("relay dinliyor");
  });

  it("migration: ilk kurulumda 3 dosya kayıtlı; ayrı migrate komutu hiçbir şeyi yeniden uygulamaz; check modunda açılır", async () => {
    expect(psql(personal, "SELECT name FROM schema_migrations ORDER BY name").split("\n")).toEqual(["001_init.sql", "002_totp_replay.sql", "003_relay_meta.sql"]);
    const appliedAt = psql(personal, "SELECT string_agg(applied_at::text, ',' ORDER BY name) FROM schema_migrations");
    const m = compose(personal, ["run", "--rm", "--no-deps", "relay", "migrate"]);
    expect(m.status).toBe(0);
    expect(m.stdout).toContain('"alreadyApplied":3');
    expect(psql(personal, "SELECT string_agg(applied_at::text, ',' ORDER BY name) FROM schema_migrations")).toBe(appliedAt);

    ok(compose(personal, ["up", "-d", "--no-build", "--wait", "relay"], { SAKLAZ_MIGRATE: "check" }), "check modu");
    expect(compose(personal, ["logs", "relay"]).stdout).toContain('"migrate":"check"');
    ok(compose(personal, ["up", "-d", "--no-build", "--wait", "relay"]), "apply moduna dönüş");
    await until("readyz", () => api(personal, "GET", "/readyz"), (r) => r.status === 200);
  });

  it("TOTP: aynı kod ikinci kez reddedilir (yanlış kodla aynı yanıt); aynı kodla 10 eşzamanlı girişten yalnızca biri başarılı", async () => {
    alice = await register(personal, "alice@ornek.com.tr");
    const code = await alice.nextCode();
    const first = await login(personal, alice, code);
    expect(first.status).toBe(200);
    tokens.push(String(first.body["accessToken"]), String(first.body["refreshToken"]));
    const replay = await login(personal, alice, code);
    const wrong = await login(personal, alice, code === "000000" ? "111111" : "000000");
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual(wrong.body);

    const bob = await register(personal, "bob@ornek.com.tr");
    const c = await bob.nextCode();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(personal, bob, c)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(9);
    expect(Number(psql(personal, "SELECT count(*) FROM audit_meta WHERE action = 'login.totp_replay'"))).toBeGreaterThanOrEqual(10);
  });

  it("relay yeniden başlatma: kullanılmış kod hâlâ reddedilir; oturum token'ı geçerli kalır; yeni kod kabul edilir", async () => {
    const tokenBefore = tokens[0] ?? "";
    ok(compose(personal, ["restart", "relay"]), "restart relay");
    await until("readyz", () => api(personal, "GET", "/readyz"), (r) => r.status === 200);
    const replay = await login(personal, alice, alice.usedCodes[0]);
    expect(replay.status).toBe(401);
    // JWT anahtarları kalıcı dosyadan okunduğu için yeniden başlatma öncesi token geçerlidir (404 = yetkili, cihaz yok).
    const authed = await api(personal, "POST", "/v1/devices/dev_olmayanCihaz00000001/disable", {}, tokenBefore);
    expect(authed.status).toBe(404);
    const fresh = await login(personal, alice);
    expect(fresh.status).toBe(200);
  });

  it("veri kalıcılığı: compose down + up (volume korunur) sonrası hesaplar, TOTP tüketim kaydı ve denetim zinciri yerinde", async () => {
    const before = psql(personal, "SELECT count(*) || ',' || (SELECT count(*) FROM audit_meta) || ',' || (SELECT max(totp_last_step) FROM accounts) FROM accounts");
    ok(compose(personal, ["down"]), "down (volume silinmeden)");
    expect(ok(run("docker", ["volume", "ls", "-q", "--filter", `name=${personal.project}_db_data`]), "volume").trim()).toBe(`${personal.project}_db_data`);
    await waitHealthy(personal);
    expect(psql(personal, "SELECT count(*) || ',' || (SELECT count(*) FROM audit_meta) || ',' || (SELECT max(totp_last_step) FROM accounts) FROM accounts")).toBe(before);
    // Kullanılmış son 3 kod (her başarısız deneme kilitlenme sayacını artırır; başarılı giriş sıfırlar).
    for (const c of alice.usedCodes.slice(-3)) expect((await login(personal, alice, c)).status).toBe(401);
    expect((await login(personal, alice)).status).toBe(200);
  });

  it("PostgreSQL kopması: relay çökmez ve yeniden başlamaz; /readyz 503, istekler ayrıntısız 503; veritabanı dönünce kendiliğinden toparlanır", async () => {
    const rid = containerId(personal, "relay");
    const startedAt = inspect<string>(rid, ".State.StartedAt");
    const restarts = inspect<number>(rid, ".RestartCount");
    ok(compose(personal, ["stop", "db"]), "db stop");
    await until("readyz 503", () => api(personal, "GET", "/readyz"), (r) => r.status === 503, 60_000);
    expect((await api(personal, "GET", "/healthz")).status).toBe(200);
    const down = await api(personal, "POST", "/v1/auth/login", { email: alice.email, password: PASSWORD, code: "123456" });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: "UNAVAILABLE" });
    expect(down.raw).not.toMatch(/ECONN|postgres|saklaz:|password|db:5432/i);

    ok(compose(personal, ["start", "db"]), "db start");
    await until("readyz 200", () => api(personal, "GET", "/readyz"), (r) => r.status === 200, 120_000);
    expect((await login(personal, alice)).status).toBe(200);
    expect(inspect<string>(rid, ".State.StartedAt")).toBe(startedAt);
    expect(inspect<number>(rid, ".RestartCount")).toBe(restarts);
    expect(compose(personal, ["logs", "relay"]).stdout).toContain("veritabanı bağlantısı koptu");
  });

  it("çökme: relay süreci SIGKILL ile öldürülünce konteyner kendiliğinden yeniden başlar; veritabanı çökmesinden de veri kaybı olmadan döner", async () => {
    const rid = containerId(personal, "relay");
    const restarts = inspect<number>(rid, ".RestartCount");
    const initPid = inspect<number>(rid, ".State.Pid");
    const nodePid = ok(run("pgrep", ["-P", String(initPid), "node"]), "node pid").trim().split("\n")[0] ?? "";
    expect(nodePid).toMatch(/^\d+$/);
    ok(sudo(["kill", "-9", nodePid]), "kill -9 relay");
    await until("relay yeniden başladı", () => inspect<number>(rid, ".RestartCount"), (n) => n > restarts, 60_000);
    await until("relay sağlıklı", () => inspect<string>(rid, ".State.Health.Status"), (s) => s === "healthy", 120_000);
    await until("readyz", () => api(personal, "GET", "/readyz"), (r) => r.status === 200);
    expect((await login(personal, alice)).status).toBe(200);

    const did = containerId(personal, "db");
    const dbRestarts = inspect<number>(did, ".RestartCount");
    const accounts = psql(personal, "SELECT count(*) FROM accounts");
    ok(sudo(["kill", "-9", String(inspect<number>(did, ".State.Pid"))]), "kill -9 postgres");
    await until("db yeniden başladı", () => inspect<number>(did, ".RestartCount"), (n) => n > dbRestarts, 60_000);
    await until("db sağlıklı", () => inspect<string>(did, ".State.Health.Status"), (s) => s === "healthy", 120_000);
    await until("readyz", () => api(personal, "GET", "/readyz"), (r) => r.status === 200, 120_000);
    expect(psql(personal, "SELECT count(*) FROM accounts")).toBe(accounts);
    for (const c of alice.usedCodes.slice(-3)) expect((await login(personal, alice, c)).status).toBe(401);
    expect((await login(personal, alice)).status).toBe(200);
  });

  it("yanlış MFA anahtarı: relay başlamaz (MFA_KEY_MISMATCH), sağlıklı olmaz; doğru anahtar geri konunca normale döner", async () => {
    const mfa = join(personal.secretsDir, "mfa_key.hex");
    ok(compose(personal, ["stop", "relay"]), "relay stop");
    ok(sudo(["cp", "-p", mfa, `${mfa}.yedek`]), "yedek");
    // Yol kabuk dizesine gömülmez; "$1" konumsal parametresi olarak geçirilir.
    ok(sudo(["sh", "-c", 'openssl rand -hex 32 > "$1" && chown 1000:1000 "$1" && chmod 0400 "$1"', "sh", mfa]), "yanlış anahtar");
    try {
      ok(compose(personal, ["up", "-d", "--no-build", "--force-recreate", "--no-deps", "relay"]), "yanlış anahtarla up");
      const rid = containerId(personal, "relay");
      await until("MFA_KEY_MISMATCH günlüğü", () => compose(personal, ["logs", "relay"]).stdout, (l) => l.includes("MFA_KEY_MISMATCH"), 90_000);
      expect(inspect<string>(rid, ".State.Health.Status")).not.toBe("healthy");
      expect(compose(personal, ["logs", "relay"]).stdout).not.toContain("relay dinliyor\",\"port");
    } finally {
      ok(sudo(["mv", "-f", `${mfa}.yedek`, mfa]), "anahtarı geri koy");
    }
    ok(compose(personal, ["up", "-d", "--no-build", "--force-recreate", "--wait", "relay"]), "doğru anahtarla up");
    await until("readyz", () => api(personal, "GET", "/readyz"), (r) => r.status === 200);
    expect((await login(personal, alice)).status).toBe(200);
  });

  it("eksik secret, ortamda secret ve yanlış veritabanı parolası: relay başlamaz, günlükte gizli değer yok", () => {
    const missing = run("docker", ["run", "--rm", "-e", "SAKLAZ_RELAY_ID=saklaz-personal", "-e", "SAKLAZ_DB_PASSWORD_FILE=/run/secrets/yok", "-e", "SAKLAZ_MFA_KEY_FILE=/run/secrets/yok2", IMAGE]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("SECRET_FILE_MISSING");

    const inEnv = run("docker", ["run", "--rm", "-e", "SAKLAZ_RELAY_ID=saklaz-personal", "-e", "SAKLAZ_DB_PASSWORD=ortamdaki-parola-xyz", IMAGE]);
    expect(inEnv.status).toBe(1);
    expect(inEnv.stdout).toContain("SECRET_IN_ENV");
    expect(inEnv.stdout + inEnv.stderr).not.toContain("ortamdaki-parola-xyz");

    // Compose: gizli dosya klasörü boşsa kurulum hiç başlamaz.
    const empty = mkdtempSync(join(tmpdir(), "saklaz-bos-"));
    try {
      const r = compose({ ...personal, project: "saklaz-a2-bos", secretsDir: empty }, ["up", "-d", "--no-build", "--wait", "--wait-timeout", "60"]);
      expect(r.status).not.toBe(0);
    } finally {
      compose({ ...personal, project: "saklaz-a2-bos", secretsDir: empty }, ["down", "-v"]);
      rmSync(empty, { recursive: true, force: true });
    }

    // Yanlış veritabanı parolası: aynı iç ağda, doğru anahtarlarla ama yanlış parolayla.
    const wrongPw = `yanlis-${randomBytes(8).toString("hex")}`;
    const pwFile = join(work, "wrong_db_password");
    writeFileSync(pwFile, wrongPw, { mode: 0o444 });
    const s = (f: string) => ["-v", `${join(personal.secretsDir, f)}:/run/secrets/${f}:ro`];
    const r = run("docker", [
      "run", "--rm", "--network", `${personal.project}_internal`,
      "-e", "SAKLAZ_RELAY_ID=saklaz-personal", "-e", "SAKLAZ_DB_HOST=db", "-e", "SAKLAZ_DB_WAIT_MS=4000",
      "-e", "SAKLAZ_DB_PASSWORD_FILE=/run/secrets/db_password", "-v", `${pwFile}:/run/secrets/db_password:ro`,
      "-e", "SAKLAZ_JWT_PRIVATE_KEY_FILE=/run/secrets/jwt_private.pem", ...s("jwt_private.pem"),
      "-e", "SAKLAZ_JWT_PUBLIC_KEY_FILE=/run/secrets/jwt_public.pem", ...s("jwt_public.pem"),
      "-e", "SAKLAZ_MFA_KEY_FILE=/run/secrets/mfa_key.hex", ...s("mfa_key.hex"),
      IMAGE,
    ], { timeoutMs: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("DB_UNREACHABLE");
    expect(r.stdout + r.stderr).not.toContain(wrongPw);
  });

  it("çalışma alanı izolasyonu: ayrı volume, ayrı ağ, ayrı anahtar; bir alanın token'ı diğerinde geçmez; ağlar arası erişim yok", async () => {
    await waitHealthy(business);
    const pAlice = await register(business, "alice@ornek.com.tr"); // aynı e-posta, ayrı kurulum
    const bl = await login(business, pAlice);
    expect(bl.status).toBe(200);
    tokens.push(String(bl.body["accessToken"]));

    const pl = await login(personal, alice);
    expect(pl.status).toBe(200);
    const personalToken = String(pl.body["accessToken"]);
    tokens.push(personalToken);
    expect((await api(business, "POST", "/v1/devices/dev_olmayanCihaz00000001/disable", {}, personalToken)).status).toBe(401);
    expect((await api(personal, "POST", "/v1/devices/dev_olmayanCihaz00000001/disable", {}, String(bl.body["accessToken"]))).status).toBe(401);

    const vols = ok(run("docker", ["volume", "ls", "-q", "--filter", "name=saklaz-a2-"]), "volume ls").trim().split("\n");
    expect(vols).toContain(`${personal.project}_db_data`);
    expect(vols).toContain(`${business.project}_db_data`);
    expect(psql(business, "SELECT count(*) FROM accounts")).toBe("1");

    // İş kurulumunun relay'i, kişisel kurulumun veritabanına ağ üzerinden ulaşamaz.
    const personalDbIp = inspect<Record<string, { IPAddress: string }>>(containerId(personal, "db"), ".NetworkSettings.Networks")[`${personal.project}_internal`]?.IPAddress ?? "";
    expect(personalDbIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = run("docker", [
      "exec", containerId(business, "relay"), "node", "-e",
      `const s=require('net').connect(5432,'${personalDbIp}');s.setTimeout(3000);s.on('connect',()=>{console.log('BAGLANDI');process.exit(0)});s.on('timeout',()=>{console.log('YOK');process.exit(3)});s.on('error',()=>{console.log('YOK');process.exit(3)});`,
    ]);
    expect(probe.stdout.trim()).toBe("YOK");
    // Kişisel kurulumun MFA anahtarı iş kurulumunun anahtarından farklıdır.
    expect(readSecretFile(personal, "mfa_key.hex")).not.toBe(readSecretFile(business, "mfa_key.hex"));
  });

  it("günlükler: hiçbir konteyner günlüğünde parola, TOTP sırrı, MFA/JWT anahtarı, veritabanı parolası veya token yok", () => {
    const all = saveLogs(personal, "tarama") + saveLogs(business, "tarama");
    expect(all.length).toBeGreaterThan(1000);
    const needles = [PASSWORD, ...secrets, ...tokens].filter((s) => s.length >= 16);
    expect(needles.length).toBeGreaterThan(8);
    for (const n of needles) expect(all.includes(n)).toBe(false);
  });
});
