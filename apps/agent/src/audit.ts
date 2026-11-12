/**
 * Hash zincirli denetim kaydı (SECURITY.md §13).
 *
 * Her kayıt bir öncekinin özetini içerir:
 *   hash = BLAKE2b("SAKLAZ-v1/audit", JCS({id, ts, action, details, prev}))
 * Aradan bir kayıt silinirse veya değiştirilirse `verify()` bunu tespit eder.
 * Zincir başı ajan anahtarıyla imzalanabilir (`signedHead`). Telefona gönderilen bu imzalı baş,
 * kaydın sondan kesilmesini tespit etmek içindir. Telefona gönderim Sprint 4'te yapılacak.
 *
 * Kayıtlara İÇERİK yazılmaz (komut metni, dosya içeriği yok). Yalnızca olay, kimlikler ve hata kodları yazılır.
 */
import { sign, taggedHash, toB64, type SigningKeyPair } from "@saklaz/crypto";
import { canonicalBytes, type JsonValue } from "@saklaz/protocol";
import type { AgentDb } from "./db.js";

const GENESIS = "A".repeat(43);

export type AuditAction =
  | "agent.start"
  | "msg.accepted"
  | "msg.duplicate"
  | "msg.rejected"
  | "roster.appended"
  | "roster.rejected"
  | "roster.forked"
  | "lockdown.engaged"
  | "lockdown.released"
  | "lockdown.release_denied"
  | "device.local_deny"
  | "restore.detected"
  | "pairing.started"
  | "pairing.completed"
  | "pairing.failed"
  | "approval.requested"
  | "approval.decided";

export interface AuditRecord {
  id: number;
  ts: number;
  action: AuditAction;
  details: Record<string, JsonValue>;
  prev: string;
  hash: string;
}

function recordHash(id: number, ts: number, action: string, details: Record<string, JsonValue>, prev: string): string {
  return toB64(taggedHash("SAKLAZ-v1/audit", canonicalBytes({ id, ts, action, details, prev }), 32));
}

export class AuditLog {
  constructor(private readonly db: AgentDb) {}

  head(): { id: number; hash: string } {
    const r = this.db.prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as
      | { id: number; hash: string }
      | undefined;
    return r ?? { id: 0, hash: GENESIS };
  }

  append(action: AuditAction, details: Record<string, JsonValue>, ts: number): AuditRecord {
    const tx = this.db.transaction(() => {
      const h = this.head();
      const id = h.id + 1;
      const hash = recordHash(id, ts, action, details, h.hash);
      this.db
        .prepare("INSERT INTO audit (id, ts, action, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, ts, action, JSON.stringify(details), h.hash, hash);
      return { id, ts, action, details, prev: h.hash, hash };
    });
    return tx();
  }

  all(): AuditRecord[] {
    const rows = this.db.prepare("SELECT id, ts, action, details, prev_hash, hash FROM audit ORDER BY id").all() as {
      id: number;
      ts: number;
      action: AuditAction;
      details: string;
      prev_hash: string;
      hash: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      action: r.action,
      details: JSON.parse(r.details) as Record<string, JsonValue>,
      prev: r.prev_hash,
      hash: r.hash,
    }));
  }

  /** Zinciri baştan doğrular. Bozulma varsa ilk bozuk kaydın kimliğini döndürür. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number } {
    let prev = GENESIS;
    let expectedId = 1;
    const rows = this.all();
    for (const r of rows) {
      if (r.id !== expectedId || r.prev !== prev || recordHash(r.id, r.ts, r.action, r.details, r.prev) !== r.hash) {
        return { ok: false, brokenAt: r.id };
      }
      prev = r.hash;
      expectedId++;
    }
    return { ok: true, count: rows.length };
  }

  /** Zincir başının ajan anahtarıyla imzası (telefona gönderilecek). */
  signedHead(agent: SigningKeyPair): { id: number; hash: string; sig: string } {
    const h = this.head();
    const sig = sign("SAKLAZ-v1/audit", canonicalBytes({ id: h.id, hash: h.hash }), agent.secretKey);
    return { ...h, sig: toB64(sig) };
  }
}
