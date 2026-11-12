/**
 * Tekrar oynatma (replay) ve zaman koruması — FAZ1-PLAN §4.4 adım 6, §8.4.
 *
 * Kayan pencere sayacı (IPsec/DTLS tarzı): her gönderen→alıcı yönü için en yüksek kabul edilen
 * sayaç ve son WINDOW içindeki görülmüş sayaçlar tutulur.
 *   • Pencerenin altında kalan sayaç → REPLAY_COUNTER (reddedilir).
 *   • Pencere içinde daha önce görülmüş sayaç → "duplicate" (yeniden İŞLENMEZ; gönderene yalnızca
 *     önceki onay tekrar gönderilir). Bu, ağ kesintisinden sonraki meşru yeniden gönderimleri
 *     güvenle karşılar.
 *   • Yeni sayaç → "fresh".
 * Neden katı "tek artan sayaç" değil: kuyruktaki eski bir mesaj, canlı daha yeni bir mesajdan
 * sonra gelebilir. Kayan pencere bu durumda mesajı kaybetmez ama hiçbir mesajı iki kez işletmez.
 *
 * Sayaç durumu, mesaj İŞLENMEDEN ÖNCE kalıcı olarak yazılmalıdır (FAZ1-PLAN §4.4 adım 8);
 * böylece çökme sonrası aynı mesaj yeniden oynatılamaz.
 */
import { ProtocolError } from "./errors.js";
import type { Header } from "./schemas.js";

export const REPLAY_WINDOW = 1024;
/** Gönderenin saati ileride olabilir; buna izin verilen tolerans. */
export const CLOCK_SKEW_MS = 5 * 60_000;

export interface ReplayState {
  highest: number;
  /** highest dahil, [highest - WINDOW + 1, highest] aralığında görülmüş sayaçlar. */
  seen: number[];
}

/** Kalıcı depo arayüzü (ajanda SQLite, testte bellek). */
export interface ReplayStore {
  load(peerId: string): ReplayState | undefined;
  save(peerId: string, state: ReplayState): void;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly m = new Map<string, ReplayState>();
  load(peerId: string): ReplayState | undefined {
    const s = this.m.get(peerId);
    return s ? { highest: s.highest, seen: [...s.seen] } : undefined;
  }
  save(peerId: string, state: ReplayState): void {
    this.m.set(peerId, { highest: state.highest, seen: [...state.seen] });
  }
}

/** İmzalı zaman alanlarını alıcının saatine göre denetler. */
export function checkTiming(hdr: Pick<Header, "ts" | "exp">, nowMs: number): void {
  if (hdr.ts > nowMs + CLOCK_SKEW_MS) throw new ProtocolError("TS_IN_FUTURE");
  if (nowMs > hdr.exp) throw new ProtocolError("MESSAGE_EXPIRED");
}

export type ReplayVerdict = "fresh" | "duplicate";

export class ReplayGuard {
  constructor(private readonly store: ReplayStore) {}

  /** Sayacı değerlendirir ve "fresh" ise durumu HEMEN kalıcı olarak kaydeder. */
  checkAndRecord(peerId: string, ctr: number): ReplayVerdict {
    const st = this.store.load(peerId) ?? { highest: 0, seen: [] };
    const floor = st.highest - REPLAY_WINDOW + 1;
    if (ctr < floor) throw new ProtocolError("REPLAY_COUNTER");
    if (st.seen.includes(ctr)) return "duplicate";
    const highest = Math.max(st.highest, ctr);
    const newFloor = highest - REPLAY_WINDOW + 1;
    const seen = [...st.seen, ctr].filter((c) => c >= newFloor);
    this.store.save(peerId, { highest, seen });
    return "fresh";
  }
}
