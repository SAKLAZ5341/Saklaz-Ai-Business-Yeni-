/**
 * Kabuk köprüsü. Android'de Flutter kabuğu `SaklazHost` JavaScript kanalını sağlar:
 *   • storage.*  → flutter_secure_storage (Android Keystore ile şifreli)
 *   • http       → yerel HTTP (relay hesap API'si ve AI; WebView'ın CORS kısıtına takılmaz)
 *   • ws.*       → relay WebSocket'i KABUKTA açılır: hedef politikası ve onay HTTP ile aynıdır.
 *                  Arayüzün CSP'si (connect-src 'none') WebView'ın doğrudan ağ bağlantısını engeller.
 *   • qr.scan    → kamera ile QR okuma
 * Kabuk yoksa (masaüstü tarayıcıda geliştirme) GÜVENSİZ geliştirme kipine düşülür ve arayüz bunu
 * açıkça gösterir; bu kip gerçek kullanım için değildir.
 */
import type { WebSocketLike } from "@saklaz/client-core";
import type { HttpPurpose, Scope } from "./netpolicy.js";

export interface HttpContext {
  /** Kabuk hedefi bu amaca göre doğrular (relay / openai / local-ai). */
  purpose: HttpPurpose;
  /** Dış hedef onayı alan başına ayrı tutulur. */
  scope: Scope;
}

export interface HostInfo {
  /** Yerel ağ TEST yapısı mı (açık metin yalnızca bu yapıda, yalnızca özel ağa). */
  lanTest: boolean;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface Host {
  readonly kind: "android" | "dev-insecure";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  http(url: string, method: string, headers: Record<string, string>, body: string | undefined, ctx: HttpContext): Promise<HttpResponse>;
  scanQr(): Promise<string | null>;
  info(): Promise<HostInfo>;
  /**
   * Dış sunucular için verilmiş gönderim onaylarını siler. Kabuk, açık bütün soketleri de kapatır
   * (CONSENT_REVOKED) ve iptalden önce başlamış bağlantı/onay girişimlerini geçersiz sayar.
   */
  clearConsents(): Promise<void>;
  /** Kabuk üzerinden WebSocket (yalnızca metin çerçeveleri). Hedef ve onay HTTP ile aynı kurallardan geçer. */
  openSocket(url: string, ctx: HttpContext): WebSocketLike;
}

/** Kabuğun soketi kapattığı kodlar (WebSocket özel aralığı 4000–4999). */
export const SOCKET_CLOSE = {
  /** Kullanıcı ağ izinlerini sıfırladı. */
  CONSENT_REVOKED: 4001,
  /** Kullanıcı onay vermedi. */
  HOST_DENIED: 4003,
  /** Hedef politikası reddetti (adres, şema, amaç). */
  POLICY: 4004,
  /** Kabuk hatası / bağlanamadı. */
  FAILED: 4010,
} as const;

/** Bu kodlarla kapanan soket için yeniden bağlanma DENENMEZ; kullanıcı eylemi gerekir. */
export function isTerminalClose(code: number): boolean {
  return code === SOCKET_CLOSE.CONSENT_REVOKED || code === SOCKET_CLOSE.HOST_DENIED || code === SOCKET_CLOSE.POLICY;
}

interface SocketEvent {
  sid: string;
  ev: "open" | "message" | "close";
  data?: string;
  code?: number;
  reason?: string;
}

/** Kabuk tarafındaki bir sokete vekil. WebSocket benzeri arayüz (RelayConnection ile kullanılır). */
export class HostSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    readonly sid: string,
    private readonly sendOp: (op: string, args: Record<string, unknown>) => Promise<unknown>,
  ) {}

  /** Kabuktan gelen olay. */
  dispatch(e: SocketEvent): void {
    if (this.readyState === 3) return;
    if (e.ev === "open" && this.readyState === 0) {
      this.readyState = 1;
      this.onopen?.({});
    } else if (e.ev === "message" && this.readyState === 1 && typeof e.data === "string") {
      this.onmessage?.({ data: e.data });
    } else if (e.ev === "close") {
      this.finish(e.code ?? 1006, e.reason ?? "");
    }
  }

  /** Kapanış: bir kez; hata kodlu kapanışta önce onerror. */
  finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (code !== 1000) this.onerror?.({ code, reason });
    this.onclose?.({ code, reason });
  }

  /** Tarayıcı WebSocket'iyle aynı: bağlanırken hata; kapandıktan sonra sessizce düşürülür. */
  send(data: string): void {
    if (this.readyState === 0) throw new Error("SOCKET_NOT_OPEN");
    if (this.readyState !== 1) return;
    void this.sendOp("ws.send", { sid: this.sid, data }).catch(() => undefined);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    void this.sendOp("ws.close", { sid: this.sid, code, reason }).catch(() => undefined);
    this.finish(code, reason);
  }
}

function newSid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Kabuğun ws.open hatası → kapanış kodu. */
function closeCodeFor(error: string): number {
  if (error === "CONSENT_REVOKED") return SOCKET_CLOSE.CONSENT_REVOKED;
  if (error === "HOST_DENIED") return SOCKET_CLOSE.HOST_DENIED;
  if (/^(CLEARTEXT_BLOCKED|TARGET_NOT_ALLOWED|TARGET_FORBIDDEN|URL_INVALID|URL_SCHEME|PURPOSE_INVALID|SCOPE_INVALID)$/.test(error)) return SOCKET_CLOSE.POLICY;
  return SOCKET_CLOSE.FAILED;
}

interface Channel {
  postMessage(msg: string): void;
}

declare global {
  interface Window {
    SaklazHost?: Channel;
    __saklazReply?: (json: string) => void;
    __saklazWsEvent?: (json: string) => void;
    __saklazTestHost?: Host;
  }
}

export class BridgeHost implements Host {
  readonly kind = "android" as const;
  private seq = 0;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  private readonly sockets = new Map<string, HostSocket>();

  constructor(private readonly ch: Channel) {
    window.__saklazWsEvent = (json: string) => {
      const e = JSON.parse(json) as SocketEvent;
      const s = this.sockets.get(e.sid);
      if (!s) return;
      if (e.ev === "close") this.sockets.delete(e.sid);
      s.dispatch(e);
    };
    window.__saklazReply = (json: string) => {
      const m = JSON.parse(json) as { id: number; ok: boolean; value?: unknown; error?: string };
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.ok) w.ok(m.value);
      else w.err(new Error(m.error ?? "HOST_ERROR"));
    };
  }

  private call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, err) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, err });
      this.ch.postMessage(JSON.stringify({ id, op, args }));
    });
  }

  get(key: string) {
    return this.call<string | null>("storage.get", { key });
  }
  set(key: string, value: string) {
    return this.call<undefined>("storage.set", { key, value }).then(() => undefined);
  }
  remove(key: string) {
    return this.call<undefined>("storage.delete", { key }).then(() => undefined);
  }
  http(url: string, method: string, headers: Record<string, string>, body: string | undefined, ctx: HttpContext) {
    return this.call<HttpResponse>("http", { url, method, headers, body: body ?? null, purpose: ctx.purpose, scope: ctx.scope });
  }
  scanQr() {
    return this.call<string | null>("qr.scan", {});
  }
  info() {
    return this.call<HostInfo>("host.info", {});
  }
  clearConsents() {
    return this.call<undefined>("consent.clear", {}).then(() => undefined);
  }
  openSocket(url: string, ctx: HttpContext): WebSocketLike {
    const s = new HostSocket(newSid(), (op, args) => this.call(op, args));
    this.sockets.set(s.sid, s);
    // Kabuk: hedef politikası → onay → bağlantı. Başarıda "open" olayı gelir; hata kodla kapanış olur.
    this.call("ws.open", { sid: s.sid, url, purpose: ctx.purpose, scope: ctx.scope }).catch((e: unknown) => {
      this.sockets.delete(s.sid);
      const code = e instanceof Error ? e.message : "HOST_ERROR";
      s.finish(closeCodeFor(code), code);
    });
    return s;
  }
}

class DevHost implements Host {
  readonly kind = "dev-insecure" as const;
  get(key: string) {
    try {
      return Promise.resolve(localStorage.getItem(`saklaz-dev:${key}`));
    } catch {
      return Promise.resolve(null);
    }
  }
  set(key: string, value: string) {
    try {
      localStorage.setItem(`saklaz-dev:${key}`, value);
    } catch {
      /* depolama yok */
    }
    return Promise.resolve();
  }
  remove(key: string) {
    try {
      localStorage.removeItem(`saklaz-dev:${key}`);
    } catch {
      /* depolama yok */
    }
    return Promise.resolve();
  }
  // Geliştirme kipi: amaç/alan bağlamı kullanılmaz (politika yalnızca Android kabuğunda uygulanır).
  async http(url: string, method: string, headers: Record<string, string>, body?: string) {
    const r = await fetch(url, { method, headers, redirect: "error", ...(body !== undefined ? { body } : {}) });
    return { status: r.status, body: await r.text() };
  }
  scanQr() {
    return Promise.resolve(null);
  }
  info() {
    return Promise.resolve({ lanTest: true });
  }
  clearConsents() {
    return Promise.resolve();
  }
  // Geliştirme kipi: doğrudan WebSocket (politika/onay yok). Yalnızca güvensiz geliştirme yapısının CSP'si izin verir.
  openSocket(url: string): WebSocketLike {
    return new WebSocket(url) as unknown as WebSocketLike;
  }
}

export function detectHost(): Host {
  if (window.__saklazTestHost) return window.__saklazTestHost;
  if (window.SaklazHost) return new BridgeHost(window.SaklazHost);
  return new DevHost();
}
