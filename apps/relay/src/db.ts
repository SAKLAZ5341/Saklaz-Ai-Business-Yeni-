import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { taggedHash, toB64 } from "@saklaz/crypto";
import { canonicalBytes, type JsonValue } from "@saklaz/protocol";

export type Pool = pg.Pool;

export interface PoolOptions {
  /** Boştaki bir bağlantıda hata olursa (ör. veritabanı yeniden başladı) çağrılır. Süreç çökmez. */
  onIdleError?: (e: Error) => void;
}

/**
 * Bağlantı havuzu. Veritabanı bağlantısı koparsa havuz bozuk istemciyi atar ve sonraki sorguda
 * yeniden bağlanır; boştaki istemcideki hata "error" olayıyla gelir ve dinlenmezse Node süreci
 * çöker. Bu yüzden olay her zaman dinlenir (Sprint 3 A2).
 */
export function createPool(connectionString: string, o: PoolOptions = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    // Takılan bir sorgu bağlantıyı süresiz tutmasın.
    statement_timeout: 15_000,
  });
  pool.on("error", (e) => {
    o.onIdleError?.(e);
  });
  return pool;
}

/** Hazır olma denetimi: veritabanına kısa süreli bir sorgu. */
export async function pingDb(pool: Pool, timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const q = pool.query("SELECT 1").then(() => true);
    const t = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    });
    return await Promise.race([q, t]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Sıralı şema dosyaları. Her dosya idempotenttir. */
export const MIGRATIONS = ["001_init.sql", "002_totp_replay.sql", "003_relay_meta.sql"] as const;

export class MigrationError extends Error {
  constructor(
    readonly code: "MIGRATION_PENDING" | "MIGRATION_MODIFIED" | "MIGRATION_UNKNOWN",
    readonly file: string,
  ) {
    super(`${code}: ${file}`);
    this.name = "MigrationError";
  }
}

export interface MigrateOptions {
  /**
   * "apply" (varsayılan): bekleyen dosyaları uygular.
   * "check": hiçbir şey değiştirmez; bekleyen dosya varsa MIGRATION_PENDING hatası verir.
   * Üretimde kontrollü yükseltme için: migration ayrı, tek seferlik bir komutla uygulanır, relay
   * "check" modunda başlatılır (infra/relay/README.md).
   */
  mode?: "apply" | "check";
  /** Testler için: dosya listesi ve klasörü. */
  files?: readonly string[];
  dir?: URL;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Şemayı kurar veya günceller (Sprint 3 A2).
 *
 * • Uygulanan her dosya, içeriğinin SHA-256 özetiyle `schema_migrations` tablosuna yazılır. Daha önce
 *   uygulanmış bir dosyanın içeriği sonradan değişmişse relay BAŞLAMAZ (MIGRATION_MODIFIED): bu,
 *   imajın kurcalandığını veya yanlış sürümün dağıtıldığını gösterir.
 * • Veritabanında kaydı olup bu sürümde bulunmayan bir dosya varsa (eski imajla yeni veritabanı)
 *   relay BAŞLAMAZ (MIGRATION_UNKNOWN): geri sürüme dönüş, şemayı bozmadan önce durdurulur.
 * • Her dosya ayrı bir işlem (transaction) içinde uygulanır; yarıda kalan dosya kayda geçmez.
 * • Dosyalar ayrıca idempotent yazılmıştır: bu kayıt tablosundan önce kurulmuş (Sprint 2) veritabanları
 *   da güvenle güncellenir.
 * • Aynı veritabanına bağlı birden fazla süreç aynı anda başlarsa danışma kilidi yarışı önler.
 */
export async function migrate(pool: Pool, o: MigrateOptions = {}): Promise<MigrateResult> {
  const files = o.files ?? MIGRATIONS;
  const dir = o.dir ?? new URL("../migrations/", import.meta.url);
  const mode = o.mode ?? "apply";
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query("SELECT pg_advisory_lock(7172)");
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name       text PRIMARY KEY,
           sha256     text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = new Map(
        (await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations")).rows.map((r) => [r.name, r.sha256]),
      );
      for (const name of done.keys()) {
        if (!files.includes(name)) throw new MigrationError("MIGRATION_UNKNOWN", name);
      }
      for (const name of files) {
        const sql = readFileSync(new URL(name, dir), "utf8");
        const sum = sha256hex(sql);
        const prev = done.get(name);
        if (prev !== undefined) {
          if (prev !== sum) throw new MigrationError("MIGRATION_MODIFIED", name);
          result.alreadyApplied.push(name);
          continue;
        }
        if (mode === "check") throw new MigrationError("MIGRATION_PENDING", name);
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sum]);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
        result.applied.push(name);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(7172)");
    }
  } finally {
    client.release();
  }
  return result;
}

const GENESIS = "A".repeat(43);

/** Meta veri denetim kaydı (hash zincirli; tablo tetikleyiciyle yalnızca eklemeye açık). */
export async function auditMeta(
  pool: Pool,
  e: { accountId: string | null; actor: string; action: string; details: Record<string, JsonValue> },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Zincirin tutarlılığı için eşzamanlı yazmaları sıraya koy.
    await client.query("SELECT pg_advisory_xact_lock(7171)");
    const prev = await client.query<{ id: string; hash: string }>("SELECT id, hash FROM audit_meta ORDER BY id DESC LIMIT 1");
    const prevHash = prev.rows[0]?.hash ?? GENESIS;
    const nextId = Number(prev.rows[0]?.id ?? 0) + 1;
    const hash = toB64(
      taggedHash("SAKLAZ-v1/audit", canonicalBytes({ id: nextId, actor: e.actor, action: e.action, details: e.details, prev: prevHash }), 32),
    );
    await client.query(
      "INSERT INTO audit_meta (id, account_id, actor, action, details, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [nextId, e.accountId, e.actor, e.action, JSON.stringify(e.details), prevHash, hash],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function verifyAuditMeta(pool: Pool): Promise<{ ok: true; count: number } | { ok: false; brokenAt: number }> {
  const r = await pool.query<{ id: string; actor: string; action: string; details: Record<string, JsonValue>; prev_hash: string; hash: string }>(
    "SELECT id, actor, action, details, prev_hash, hash FROM audit_meta ORDER BY id",
  );
  let prev = GENESIS;
  for (const row of r.rows) {
    const id = Number(row.id);
    const h = toB64(taggedHash("SAKLAZ-v1/audit", canonicalBytes({ id, actor: row.actor, action: row.action, details: row.details, prev: row.prev_hash }), 32));
    if (row.prev_hash !== prev || h !== row.hash) return { ok: false, brokenAt: id };
    prev = row.hash;
  }
  return { ok: true, count: r.rows.length };
}
