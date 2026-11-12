/**
 * Geri yükleme (rollback) koruması — ADR-0016, SECURITY.md §20.
 *
 * Monoton bir "durum dönemi" iki yerde tutulur:
 *   • veritabanında (meta.epoch) — yedeğe girer
 *   • kasada (vault "state-epoch") — yedeğe GİRMEZ
 *
 * Her kalıcı sayaç yazımında dönem artırılır. Sıralama: önce veritabanı, sonra kasa.
 * Bu sırada bir çökme olursa veritabanı kasadan ileride kalır; bu durum güvenlidir ve bir sonraki
 * açılışta kasa yükseltilir.
 *
 * Açılışta veritabanı dönemi kasadakinden GERİDEYSE eski bir yedek geri yüklenmiş demektir.
 * Bu durumda geri yükleme tabanı = şimdi olur; bu andan önceki zaman damgalı her mesaj reddedilir.
 * Böylece yedekten sonra işlenmiş komutlar, yeniden oynatılsalar bile çalışmaz.
 */
import { getMeta, setMeta, type AgentDb } from "./db.js";
import type { SecretVault } from "./vault.js";

const VAULT_KEY = "state-epoch";

function readVaultEpoch(v: SecretVault): number {
  const b = v.get(VAULT_KEY);
  if (!b || b.length !== 8) return 0;
  return Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, false));
}

function writeVaultEpoch(v: SecretVault, n: number): void {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  v.set(VAULT_KEY, b);
}

export interface RollbackStatus {
  restoreDetected: boolean;
  restoreFloorMs: number | undefined;
  dbEpoch: number;
  vaultEpoch: number;
}

export class RollbackGuard {
  private floor: number | undefined;

  constructor(
    private readonly db: AgentDb,
    private readonly vault: SecretVault,
  ) {
    const f = getMeta(db, "restore_floor");
    this.floor = f === undefined ? undefined : Number(f);
  }

  /** Açılışta çağrılır. Geri yükleme tespit edilirse tabanı ayarlar ve durumu döndürür. */
  checkOnStartup(nowMs: number): RollbackStatus {
    const dbEpoch = Number(getMeta(this.db, "epoch") ?? "0");
    const vaultEpoch = readVaultEpoch(this.vault);
    const restoreDetected = dbEpoch < vaultEpoch;
    if (restoreDetected) this.setFloor(nowMs);
    // Her iki tarafı da en yüksek değerin bir fazlasına getir.
    const next = Math.max(dbEpoch, vaultEpoch) + 1;
    setMeta(this.db, "epoch", String(next));
    writeVaultEpoch(this.vault, next);
    return { restoreDetected, restoreFloorMs: this.floor, dbEpoch, vaultEpoch };
  }

  /** Her kalıcı sayaç yazımından sonra çağrılır. */
  bump(): void {
    const next = Number(getMeta(this.db, "epoch") ?? "0") + 1;
    setMeta(this.db, "epoch", String(next));
    writeVaultEpoch(this.vault, next);
  }

  /** Kullanıcının başlattığı resmî geri yükleme akışı da aynı tabanı ayarlar. */
  setFloor(nowMs: number): void {
    this.floor = Math.max(this.floor ?? 0, nowMs);
    setMeta(this.db, "restore_floor", String(this.floor));
  }

  get restoreFloorMs(): number | undefined {
    return this.floor;
  }
}
