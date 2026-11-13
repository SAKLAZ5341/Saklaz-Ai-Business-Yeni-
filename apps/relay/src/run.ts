/**
 * Relay açılış ve kapanış mantığı (Sprint 3 A2). Süreç düzeyindeki işler (sinyaller, çıkış kodu,
 * komut satırı) main.ts'tedir; bu modül süreç içinde test edilebilir.
 *
 * Açılış sırası; herhangi bir adım başarısızsa relay dinlemeye BAŞLAMAZ:
 *   1. Yapılandırma ve gizli bilgiler (config.ts): yalnızca dosyadan; ortamda düz gizli değer yasak.
 *   2. Veritabanını bekleme (üstel geri çekilme, SAKLAZ_DB_WAIT_MS).
 *   3. Şema: SAKLAZ_MIGRATE=apply (varsayılan) uygular; =check yalnızca denetler.
 *   4. JWT anahtar çifti denetimi; MFA anahtarının bu veritabanıyla uyumu.
 *   5. Dinleme.
 *
 * Günlükler tek satırlık JSON'dur. Gizli değerler, parola, TOTP kodu, token, istek gövdesi ve
 * bağlantı adresi hiçbir zaman günlüğe yazılmaz.
 */
import { initCrypto } from "@saklaz/crypto";
import { Accounts, canDecryptSecret } from "./accounts.js";
import { ConfigError, loadConfig, type RelayConfig } from "./config.js";
import { createPool, migrate, MigrationError, pingDb, type Pool } from "./db.js";
import type { PushNotifier } from "./hub.js";
import { buildRelay } from "./server.js";
import { ensureMfaKey, loadJwtKeys, StartupError, waitForDb } from "./startup.js";

export type Level = "fatal" | "error" | "warn" | "info" | "debug";
export type LogFields = Record<string, string | number | boolean | null>;
export type Log = (level: Level, msg: string, fields?: LogFields) => void;

const ORDER: Record<Level, number> = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20 };

/** JSON satır günlükçüsü. Seviye, yapılandırma okunduktan sonra ayarlanabilir. */
export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l)): Log & { setLevel: (l: Level) => void } {
  let min: Level = "info";
  const log = ((level: Level, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[min]) return;
    write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })}\n`);
  }) as Log & { setLevel: (l: Level) => void };
  log.setLevel = (l) => {
    min = l;
  };
  return log;
}

/** Hata nesnesinden yalnızca güvenli alanlar: ad ve kod. Açıklama yalnızca kendi hata sınıflarımızda. */
export function describeError(e: unknown): Record<string, string | null> {
  if (e instanceof ConfigError || e instanceof StartupError || e instanceof MigrationError) {
    return { error: e.name, code: e.code, detail: e.message };
  }
  if (typeof e !== "object" || e === null) return { error: "Error", code: null };
  const x = e as { name?: unknown; code?: unknown };
  return { error: typeof x.name === "string" ? x.name : "Error", code: typeof x.code === "string" ? x.code : null };
}

/** FCM entegrasyonu Sprint 4'te. Şimdilik hiçbir şey göndermez. */
class NoopPush implements PushNotifier {
  wake(): Promise<void> {
    return Promise.resolve();
  }
}

type Env = Readonly<Record<string, string | undefined>>;

async function connect(cfg: RelayConfig, log: Log): Promise<Pool> {
  const pool = createPool(cfg.secrets.databaseUrl, {
    onIdleError: (e) => {
      log("warn", "veritabanı bağlantısı koptu; sonraki istekte yeniden bağlanılacak", describeError(e));
    },
  });
  try {
    await waitForDb(pool, {
      maxWaitMs: cfg.dbWaitMs,
      onRetry: (attempt, delayMs) => {
        log("warn", "veritabanı bekleniyor", { attempt, delayMs });
      },
    });
  } catch (e) {
    await pool.end();
    throw e;
  }
  return pool;
}

/** `migrate` komutu: yalnızca şemayı uygular. */
export async function runMigrate(env: Env, log: Log & { setLevel: (l: Level) => void }): Promise<void> {
  const cfg = loadConfig(env);
  log.setLevel(cfg.logLevel);
  const pool = await connect(cfg, log);
  try {
    const r = await migrate(pool, { mode: "apply" });
    log("info", "şema güncel", { applied: r.applied.join(",") || "-", alreadyApplied: r.alreadyApplied.length });
  } finally {
    await pool.end();
  }
}

export interface RunningRelay {
  port: number;
  /** Düzgün kapanma: yeni bağlantı alınmaz, açık bağlantılar kapatılır, havuz kapanır. */
  stop: () => Promise<void>;
}

/** `serve` komutu: açılış denetimlerini yapar ve dinlemeye başlar. */
export async function runServer(env: Env, log: Log & { setLevel: (l: Level) => void }): Promise<RunningRelay> {
  const cfg = loadConfig(env);
  log.setLevel(cfg.logLevel);
  log("info", "relay başlıyor", { relayId: cfg.relayId, migrate: cfg.migrateMode, trustProxyHops: cfg.trustProxyHops });
  await initCrypto();
  const pool = await connect(cfg, log);
  try {
    const m = await migrate(pool, { mode: cfg.migrateMode });
    log("info", "şema güncel", { applied: m.applied.join(",") || "-", alreadyApplied: m.alreadyApplied.length });

    const { privateKey, publicKey } = await loadJwtKeys(cfg.secrets.jwtPrivatePem, cfg.secrets.jwtPublicPem, cfg.relayId);
    const mfa = await ensureMfaKey(pool, cfg.secrets.mfaKey, (blob) => canDecryptSecret(cfg.secrets.mfaKey, blob));
    log("info", "anahtarlar doğrulandı", { mfaKeyCheck: mfa });

    const accounts = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey: cfg.secrets.mfaKey, issuer: cfg.relayId });
    const { app, hub } = buildRelay({
      pool,
      accounts,
      relayId: cfg.relayId,
      push: new NoopPush(),
      trustProxy: cfg.trustProxyHops === 0 ? false : cfg.trustProxyHops,
      logger: { level: cfg.logLevel === "debug" ? "info" : "warn" },
      ready: () => pingDb(pool),
    });

    const sweep = setInterval(() => {
      hub.sweepExpired().catch((e: unknown) => {
        log("warn", "süresi dolan zarflar temizlenemedi", describeError(e));
      });
    }, 60_000);

    await app.listen({ host: cfg.host, port: cfg.port });
    const addr = app.server.address();
    const port = addr && typeof addr !== "string" ? addr.port : cfg.port;
    log("info", "relay dinliyor", { port });

    let stopped: Promise<void> | undefined;
    return {
      port,
      stop: () => {
        stopped ??= (async () => {
          clearInterval(sweep);
          await app.close();
          await pool.end();
        })();
        return stopped;
      },
    };
  } catch (e) {
    await pool.end();
    throw e;
  }
}
