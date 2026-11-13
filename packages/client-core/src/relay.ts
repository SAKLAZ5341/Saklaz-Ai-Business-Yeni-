/**
 * Relay bağlantısı (telefon tarafı). Ajanın RelayClient'ıyla aynı tel protokolü; standart WebSocket
 * API'sini kullanır (Android WebView, tarayıcı, Node 22).
 *
 *   auth(token) → challenge → auth.proof (cihaz anahtarıyla imza) → ready
 * Gelen teslimler işlendikten SONRA "delivered" gönderilir; işleme hatasında gönderilmez (relay yeniden iletir).
 */
import { randomBytes, sign, toB64, type SigningKeyPair } from "@saklaz/crypto";
import { canonicalBytes, relayAuthPayload, ServerFrameSchema, type ClientFrame, type WireOut } from "@saklaz/protocol";
import type { ReceivedFrame } from "./client.js";

export type RelayState = "connecting" | "ready" | "closed" | "error";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface PresenceItem {
  deviceId: string;
  online: boolean;
  lastSeen: number | null;
}

export interface RelayConnectionOptions {
  url: string;
  deviceId: string;
  sign: SigningKeyPair;
  getToken: () => Promise<string>;
  onFrames: (frames: ReceivedFrame[]) => Promise<void> | void;
  onState?: (s: RelayState, code?: string) => void;
  onPresence?: (items: PresenceItem[]) => void;
  createSocket?: (url: string) => WebSocketLike;
  batchWindowMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const OPEN = 1;

function uuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function ttlFor(kind: WireOut["kind"]): number {
  return kind === "sealed" ? 72 * 3600 : kind === "pair" ? 5 * 60 : 10 * 60;
}

export class RelayConnection {
  private ws: WebSocketLike | undefined;
  private ready = false;
  private stopped = true;
  private backoff: number;
  private readonly pending: ClientFrame[] = [];
  private batch: { frames: ReceivedFrame[]; ids: string[] } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: RelayConnectionOptions) {
    this.backoff = o.minBackoffMs ?? 500;
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000, "stop");
  }

  /** Bağlantı hazır değilse çerçeveler sıraya alınır ve bağlanınca gönderilir. */
  send(outs: WireOut[]): void {
    for (const o of outs) this.enqueue({ t: "send", id: uuid(), to: o.to, kind: o.kind, ttlSec: ttlFor(o.kind), ct: o.ct });
  }

  queryPresence(deviceIds: string[]): void {
    if (deviceIds.length) this.enqueue({ t: "presence.query", deviceIds: deviceIds.slice(0, 100) });
  }

  private enqueue(f: ClientFrame): void {
    if (this.ready && this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(f));
    else this.pending.push(f);
  }

  private connect(): void {
    if (this.stopped) return;
    this.o.onState?.("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.o.createSocket ? this.o.createSocket(this.o.url) : (new WebSocket(this.o.url) as unknown as WebSocketLike);
    } catch {
      this.o.onState?.("error", "URL_INVALID");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.o.getToken().then(
        (token) => {
          ws.send(JSON.stringify({ t: "auth", deviceId: this.o.deviceId, token } satisfies ClientFrame));
        },
        () => {
          this.o.onState?.("error", "TOKEN_UNAVAILABLE");
          ws.close(1000, "token");
        },
      );
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onMessage(ws, ev.data);
    };
    ws.onerror = () => {
      this.o.onState?.("error", "SOCKET_ERROR");
    };
    ws.onclose = () => {
      this.ready = false;
      this.o.onState?.("closed");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const jitter = Math.random() * this.backoff * 0.3;
    this.timer = setTimeout(() => {
      this.connect();
    }, this.backoff + jitter);
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 60_000);
  }

  private onMessage(ws: WebSocketLike, text: string): void {
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
        for (const out of this.pending.splice(0)) ws.send(JSON.stringify(out));
        return;
      }
      case "deliver": {
        if (!this.batch) {
          this.batch = { frames: [], ids: [] };
          setTimeout(() => {
            void this.flush(ws);
          }, this.o.batchWindowMs ?? 25);
        }
        this.batch.frames.push({ from: f.from, kind: f.kind, ct: f.ct });
        this.batch.ids.push(f.id);
        return;
      }
      case "presence":
        this.o.onPresence?.(f.items);
        return;
      case "error":
        this.o.onState?.("error", f.code);
        return;
      default:
        return;
    }
  }

  private async flush(ws: WebSocketLike): Promise<void> {
    const b = this.batch;
    this.batch = undefined;
    if (!b) return;
    try {
      await this.o.onFrames(b.frames);
    } catch {
      this.o.onState?.("error", "PROCESS_FAILED");
      return;
    }
    for (const id of b.ids) if (ws.readyState === OPEN) ws.send(JSON.stringify({ t: "delivered", id } satisfies ClientFrame));
  }
}
