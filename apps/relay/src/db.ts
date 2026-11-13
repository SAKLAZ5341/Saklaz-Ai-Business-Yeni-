import { readFileSync } from "node:fs";
import pg from "pg";
import { taggedHash, toB64 } from "@saklaz/crypto";
import { canonicalBytes, type JsonValue } from "@saklaz/protocol";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Sıralı şema dosyaları. Her dosya idempotenttir ve her açılışta yeniden çalıştırılır. */
export const MIGRATIONS = ["001_init.sql", "002_totp_replay.sql"] as const;

/**
 * Şemayı kurar veya günceller. Aynı veritabanına bağlı birden fazla relay süreci aynı anda
 * başlarsa yarış olmaması için oturum düzeyinde bir danışma kilidi (advisory lock) tutulur.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7172)");
    try {
      for (const f of MIGRATIONS) {
        await client.query(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(7172)");
    }
  } finally {
    client.release();
  }
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
