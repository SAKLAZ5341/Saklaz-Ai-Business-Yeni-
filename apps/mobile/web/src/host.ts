/**
 * Kabuk köprüsü. Android'de Flutter kabuğu `SaklazHost` JavaScript kanalını sağlar:
 *   • storage.*  → flutter_secure_storage (Android Keystore ile şifreli)
 *   • http       → yerel HTTP (relay hesap API'si ve AI; WebView'ın CORS kısıtına takılmaz)
 *   • qr.scan    → kamera ile QR okuma
 * Kabuk yoksa (masaüstü tarayıcıda geliştirme) GÜVENSİZ geliştirme kipine düşülür ve arayüz bunu
 * açıkça gösterir; bu kip gerçek kullanım için değildir.
 */
export interface HttpResponse {
  status: number;
  body: string;
}

export interface Host {
  readonly kind: "android" | "dev-insecure";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  http(url: string, method: string, headers: Record<string, string>, body?: string): Promise<HttpResponse>;
  scanQr(): Promise<string | null>;
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
  http(url: string, method: string, headers: Record<string, string>, body?: string) {
    return this.call<HttpResponse>("http", { url, method, headers, body: body ?? null });
  }
  scanQr() {
    return this.call<string | null>("qr.scan", {});
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
  async http(url: string, method: string, headers: Record<string, string>, body?: string) {
    const r = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: r.status, body: await r.text() };
  }
  scanQr() {
    return Promise.resolve(null);
  }
}

export function detectHost(): Host {
  if (window.__saklazTestHost) return window.__saklazTestHost;
  if (window.SaklazHost) return new BridgeHost(window.SaklazHost);
  return new DevHost();
}
