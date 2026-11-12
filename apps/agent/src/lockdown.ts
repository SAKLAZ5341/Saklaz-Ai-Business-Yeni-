/**
 * Acil kilit — FAZ1-PLAN §16.3, SECURITY.md S21.
 *
 * Kilit devredeyken:
 *   • relay bağlantısı kesilir (bağlantı katmanına bildirilir)
 *   • uzaktan gelen hiçbir mesaj işlenmez
 *   • kilit kalıcıdır; ajan yeniden başlasa da sürer
 *   • kilit YALNIZCA yerelde açılır (LocalAuthenticator: Windows Hello / yönetici PIN — Sprint 4)
 *
 * Kilidi açacak uzak bir mesaj tipi bilinçli olarak YOKTUR.
 */
import { getMeta, setMeta, type AgentDb } from "./db.js";

export interface LocalAuthenticator {
  /** Yerel kullanıcının kimliğini doğrular (Windows Hello / PIN). Başarılıysa true döner. */
  verify(reason: string): Promise<boolean>;
}

export interface LockdownInfo {
  locked: boolean;
  since?: number;
  source?: string;
  reason?: string;
}

export class Lockdown {
  constructor(private readonly db: AgentDb) {}

  info(): LockdownInfo {
    const raw = getMeta(this.db, "lockdown");
    return raw ? (JSON.parse(raw) as LockdownInfo) : { locked: false };
  }

  get locked(): boolean {
    return this.info().locked;
  }

  engage(source: string, reason: string, nowMs: number): void {
    if (this.locked) return;
    setMeta(this.db, "lockdown", JSON.stringify({ locked: true, since: nowMs, source, reason }));
  }

  /** Yerel kimlik doğrulaması olmadan kilit açılmaz. */
  async release(auth: LocalAuthenticator): Promise<boolean> {
    if (!this.locked) return true;
    const ok = await auth.verify("SAKLAZ acil kilidini açmak için kimliğinizi doğrulayın");
    if (ok) setMeta(this.db, "lockdown", JSON.stringify({ locked: false }));
    return ok;
  }
}
