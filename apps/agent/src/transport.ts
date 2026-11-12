/**
 * Relay istemcisi (giden WSS bağlantısı). Ajan hiçbir port DİNLEMEZ; yalnızca relay'e bağlanır.
 *
 * Bağlantı adımları:
 *   1. auth: erişim token'ı ile başvuru
 *   2. challenge: relay rastgele bir nonce gönderir
 *   3. auth.proof: cihaz anahtarıyla imza (SAKLAZ-v1/relay-auth)
 *   4. ready: bağlantı kullanıma hazır
 *
 * Gelen teslimler kısa bir pencerede (varsayılan 25 ms) toplanıp TEK GRUP halinde işlenir. Böylece
 * kuyrukta biriken bir acil kilit, kendinden önce kuyruğa girmiş komutlardan önce uygulanır.
 * Bir grup işlendikten sonra relay'e "delivered" bildirilir ve relay zarfı siler.
 * Bağlantı koparsa üstel geri çekilme ve rastgele sapma ile yeniden bağlanılır.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { sign, toB64, type SigningKeyPair } from "@saklaz/crypto";
import { canonicalBytes, relayAuthPayload, ServerFrameSchema, type ClientFrame, type WireOut } from "@saklaz/protocol";
import type { IncomingFrame } from "./core.js";

export interface RelayClientOptions {
  url: string;
  deviceId: string;
  sign: SigningKeyPair;
  getToken: () => Promise<string> | string;
  onFrames: (frames: IncomingFrame[]) => Promise<void> | void;
  batchWindowMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onState?: (s: "connecting" | "ready" | "closed" | "error", detail?: string) => void;
}

/** WebSocket yükünü UTF-8 metne çevirir (Buffer, ArrayBuffer veya parça dizisi olabilir). */
function rawToString(d: WebSocket.RawData): string {
  if (Buffer.isBuffer(d)) return d.toString("utf8");
  if (Array.isArray(d)) return Buffer.concat(d).toString("utf8");
  return Buffer.from(d).toString("utf8");
}
export function ttlFor(kind: WireOut["kind"]): number {
  // Mühürlü zarflar ve eşleştirme mesajları kuyrukta bekleyebilir; oturum mesajları kısa ömürlüdür.
  return kind === "sealed" ? 72 * 3600 : kind === "pair" ? 5 * 60 : 10 * 60;
}

export class RelayClient {
  private ws: WebSocket | undefined;
  private ready = false;
  private stopped = false;
  private backoff: number;
  private readonly pendingOut: ClientFrame[] = [];
  private batch: { frames: IncomingFrame[]; ids: string[] } | undefined;
  private readyWaiters: (() => void)[] = [];

  constructor(private readonly o: RelayClientOptions) {
    this.backoff = o.minBackoffMs ?? 500;
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Acil kilit veya kapanış: bağlantıyı keser ve yeniden bağlanmaz. */
  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.ws?.close(1000, "stop");
  }

  waitReady(timeoutMs = 5000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error("relay hazır değil"));
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  send(outs: WireOut[]): void {
    for (const o of outs) {
      this.enqueue({ t: "send", id: randomUUID(), to: o.to, kind: o.kind, ttlSec: ttlFor(o.kind), ct: o.ct });
    }
  }

  presence(deviceIds: string[]): void {
    this.enqueue({ t: "presence.query", deviceIds });
  }

  private enqueue(f: ClientFrame): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
    else this.pendingOut.push(f);
  }

  private connect(): void {
    if (this.stopped) return;
    this.o.onState?.("connecting");
    const ws = new WebSocket(this.o.url, { maxPayload: 400 * 1024 });
    this.ws = ws;
    ws.on("open", () => {
      void Promise.resolve(this.o.getToken()).then((token) => {
        ws.send(JSON.stringify({ t: "auth", deviceId: this.o.deviceId, token } satisfies ClientFrame));
      });
    });
    ws.on("message", (data) => {
      this.onMessage(ws, rawToString(data));
    });
    ws.on("close", () => {
      this.ready = false;
      this.o.onState?.("closed");
      if (!this.stopped) {
        const jitter = Math.random() * this.backoff * 0.3;
        setTimeout(() => {
          this.connect();
        }, this.backoff + jitter);
        this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 300_000);
      }
    });
    ws.on("error", (e) => {
      this.o.onState?.("error", e.message);
    });
  }

  private onMessage(ws: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const p = ServerFrameSchema.safeParse(parsed);
    if (!p.success) return;
    const f = p.data;
    switch (f.t) {
      case "challenge": {
        const sig = sign("SAKLAZ-v1/relay-auth", canonicalBytes(relayAuthPayload(this.o.deviceId, f.nonce, f.relayId)), this.o.sign.secretKey);
        ws.send(JSON.stringify({ t: "auth.proof", sig: toB64(sig) } satisfies ClientFrame));
        return;
      }
      case "ready": {
        this.ready = true;
        this.backoff = this.o.minBackoffMs ?? 500;
        this.o.onState?.("ready");
        for (const w of this.readyWaiters.splice(0)) w();
        for (const out of this.pendingOut.splice(0)) ws.send(JSON.stringify(out));
        return;
      }
      case "deliver": {
        if (!this.batch) {
          this.batch = { frames: [], ids: [] };
          setTimeout(() => {
            void this.flushBatch(ws);
          }, this.o.batchWindowMs ?? 25);
        }
        this.batch.frames.push({ from: f.from, kind: f.kind, ct: f.ct });
        this.batch.ids.push(f.id);
        return;
      }
      default:
        return;
    }
  }

  private async flushBatch(ws: WebSocket): Promise<void> {
    const b = this.batch;
    this.batch = undefined;
    if (!b) return;
    try {
      await this.o.onFrames(b.frames);
    } catch (e) {
      // Beklenmeyen işleme hatası: teslim onayı GÖNDERİLMEZ; relay zarfları yeniden iletir.
      this.o.onState?.("error", e instanceof Error ? e.message : "onFrames");
      return;
    }
    // İşlendikten SONRA teslim onayı: ajan çökerse relay yeniden iletir; tekrar oynatma koruması yinelenmeyi önler.
    for (const id of b.ids) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "delivered", id } satisfies ClientFrame));
  }
}
