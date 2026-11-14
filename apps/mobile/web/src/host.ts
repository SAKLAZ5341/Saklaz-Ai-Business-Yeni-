/**
 * Kabuk köprüsü. Android'de Flutter kabuğu `SaklazHost` JavaScript kanalını sağlar:
 *   • storage.*  → flutter_secure_storage (Android Keystore ile şifreli)
 *   • http       → yerel HTTP (relay hesap API'si ve AI; WebView'ın CORS kısıtına takılmaz)
 *   • qr.scan    → kamera ile QR okuma
 * Kabuk yoksa (masaüstü tarayıcıda geliştirme) GÜVENSİZ geliştirme kipine düşülür ve arayüz bunu
 * açıkça gösterir; bu kip gerçek kullanım için değildir.
 */
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
  /** Dış sunucular için verilmiş gönderim onaylarını siler. */
  clearConsents(): Promise<void>;
}

interface Channel {
  postMessage(msg: string): void;
}

declare global {
  interface Window {
    SaklazHost?: Channel;
    __saklazReply?: (json: string) => void;
    __saklazTestHost?: Host;
  }
}

class BridgeHost implements Host {
  readonly kind = "android" as const;
  private seq = 0;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();

  constructor(private readonly ch: Channel) {
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
}

export function detectHost(): Host {
  if (window.__saklazTestHost) return window.__saklazTestHost;
  if (window.SaklazHost) return new BridgeHost(window.SaklazHost);
  return new DevHost();
}
