/**
 * Protokol paketinin depo arayüzlerinin SQLite uygulamaları.
 */
import type { ApprovalStore, PendingApproval, ReplayState, ReplayStore, RosterEntry } from "@saklaz/protocol";
import { RosterLog } from "@saklaz/protocol";
import type { AgentDb } from "./db.js";

export class SqliteReplayStore implements ReplayStore {
  constructor(
    private readonly db: AgentDb,
    /** Her kalıcı sayaç yazımından sonra çağrılır (geri yükleme koruması dönemi artırır). */
    private readonly afterWrite: () => void = () => undefined,
  ) {}

  load(peerId: string): ReplayState | undefined {
    const r = this.db.prepare("SELECT highest, seen FROM replay WHERE peer = ?").get(peerId) as
      | { highest: number; seen: string }
      | undefined;
    return r ? { highest: r.highest, seen: JSON.parse(r.seen) as number[] } : undefined;
  }

  save(peerId: string, state: ReplayState): void {
    this.db
      .prepare(
        "INSERT INTO replay (peer, highest, seen) VALUES (?, ?, ?) ON CONFLICT(peer) DO UPDATE SET highest = excluded.highest, seen = excluded.seen",
      )
      .run(peerId, state.highest, JSON.stringify(state.seen));
    this.afterWrite();
  }
}

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: AgentDb) {}
  get(id: string): PendingApproval | undefined {
    const r = this.db.prepare("SELECT record FROM approvals WHERE id = ?").get(id) as { record: string } | undefined;
    return r ? (JSON.parse(r.record) as PendingApproval) : undefined;
  }
  put(rec: PendingApproval): void {
    this.db
      .prepare("INSERT INTO approvals (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
      .run(rec.approvalId, JSON.stringify(rec));
  }
}

/** Cihaz listesini veritabanından yükler; her giriş yeniden doğrulanır (bozuk depo kabul edilmez). */
export function loadRoster(db: AgentDb): RosterLog | undefined {
  const rows = db.prepare("SELECT entry FROM roster ORDER BY seq").all() as { entry: string }[];
  if (rows.length === 0) return undefined;
  return RosterLog.fromEntries(rows.map((r) => JSON.parse(r.entry) as unknown));
}

export function persistRosterEntry(db: AgentDb, e: RosterEntry): void {
  db.prepare("INSERT INTO roster (seq, entry) VALUES (?, ?)").run(e.seq, JSON.stringify(e));
}
