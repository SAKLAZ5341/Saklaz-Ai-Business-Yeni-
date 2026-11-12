/**
 * Ajanın şifreli yerel veritabanı (SQLCipher, better-sqlite3-multiple-ciphers).
 *
 * Şifreleme anahtarı kasadadır ve veritabanıyla birlikte saklanmaz. Yanlış anahtarla açma denemesi
 * SQLITE_NOTADB hatası verir. Bu durum Sprint 2'de Linux'ta doğrulandı; Windows doğrulaması CI'da yapılacak.
 *
 * Tüm yazmalar eşzamanlıdır (better-sqlite3). Tekrar oynatma durumu, mesaj İŞLENMEDEN ÖNCE
 * diske yazılır (FAZ1-PLAN §4.4 adım 8).
 */
import Database from "better-sqlite3-multiple-ciphers";
import { randomBytes } from "@saklaz/crypto";
import type { SecretVault } from "./vault.js";

export type AgentDb = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE replay (peer TEXT PRIMARY KEY, highest INTEGER NOT NULL, seen TEXT NOT NULL);
   CREATE TABLE approvals (id TEXT PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE roster (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     action TEXT NOT NULL,
     details TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL
   );
   CREATE TABLE local_deny (device_id TEXT PRIMARY KEY, reason TEXT NOT NULL, ts INTEGER NOT NULL);
   CREATE TABLE outbox (
     id TEXT PRIMARY KEY,
     to_device TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
];

export const DB_KEY_NAME = "db-key";

/** Veritabanını açar; ilk açılışta rastgele 256 bit anahtar üretip kasaya yazar. */
export function openAgentDb(path: string, vault: SecretVault): AgentDb {
  let key = vault.get(DB_KEY_NAME);
  if (!key) {
    key = randomBytes(32);
    vault.set(DB_KEY_NAME, key);
  }
  const db = new Database(path);
  db.pragma("cipher='sqlcipher'");
  db.pragma(`key="x'${Buffer.from(key).toString("hex")}'"`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: AgentDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
  const current = row?.v ?? 0;
  const apply = db.transaction(() => {
    for (let i = current; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i] ?? "");
    if (row) db.prepare("UPDATE schema_version SET v = ?").run(MIGRATIONS.length);
    else db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(MIGRATIONS.length);
  });
  apply();
}

export function getMeta(db: AgentDb, key: string): string | undefined {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}

export function setMeta(db: AgentDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
