/**
 * Relay hesap API'si: hesap oluşturma, giriş (parola + TOTP), token yenileme, cihaz kaydı.
 * Bu katman yalnızca relay'e BAĞLANMA yetkisi verir; komut yetkisi cihaz anahtarı imzasıyladır.
 */
import { sign, toB64, type SigningKeyPair } from "@saklaz/crypto";
import { canonicalBytes } from "@saklaz/protocol";

export class RelayApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "RelayApiError";
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** wss://alan/v1/connect ↔ https://alan */
export function httpBaseFromRelay(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new RelayApiError("URL_INVALID", 0);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}

export function connectUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/v1/connect`;
}

export class RelayApi {
  private readonly base: string;
  constructor(
    relayUrl: string,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.base = httpBaseFromRelay(relayUrl);
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    let res;
    try {
      res = await this.fetchFn(this.base + path, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      throw new RelayApiError("NETWORK", 0);
    }
    let data: unknown = {};
    try {
      data = await res.json();
    } catch {
      /* boş gövde */
    }
    if (res.status >= 400) {
      const code = typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : "HTTP_ERROR";
      throw new RelayApiError(code, res.status);
    }
    return data as T;
  }

  register(email: string, password: string): Promise<{ accountId: string; otpauth: string }> {
    return this.post("/v1/accounts", { email, password });
  }

  login(email: string, password: string, code: string): Promise<{ accessToken: string; refreshToken: string; accountId: string }> {
    return this.post("/v1/auth/login", { email, password, code });
  }

  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    return this.post("/v1/auth/refresh", { refreshToken });
  }

  /** Cihazı hesaba kaydeder; cihaz anahtarı sahipliği imzayla kanıtlanır. Zaten kayıtlıysa sorun değildir. */
  async registerDevice(accessToken: string, accountId: string, deviceId: string, kind: "phone" | "computer", keys: SigningKeyPair): Promise<"created" | "exists"> {
    const signPub = toB64(keys.publicKey);
    const proof = toB64(sign("SAKLAZ-v1/relay-auth", canonicalBytes({ deviceId, signPub, accountId }), keys.secretKey));
    try {
      await this.post("/v1/devices", { deviceId, kind, signPub, proof }, accessToken);
      return "created";
    } catch (e) {
      if (e instanceof RelayApiError && e.code === "DEVICE_EXISTS") return "exists";
      throw e;
    }
  }
}

/**
 * Erişim token'ı yöneticisi: kısa ömürlü erişim token'ını gerektiğinde dönen yenileme token'ıyla
 * yeniler ve yeni yenileme token'ını kaydettirir (eski token yeniden kullanılırsa relay aileyi iptal eder).
 */
export class TokenManager {
  private access: { token: string; until: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly api: RelayApi,
    private refreshToken: string,
    private readonly saveRefresh: (t: string) => Promise<void> | void,
    private readonly now: () => number = Date.now,
  ) {}

  setAccess(token: string, ttlMs = 4 * 60_000): void {
    this.access = { token, until: this.now() + ttlMs };
  }

  get(): Promise<string> {
    if (this.access && this.access.until > this.now()) return Promise.resolve(this.access.token);
    this.inflight ??= (async () => {
      try {
        const r = await this.api.refresh(this.refreshToken);
        this.refreshToken = r.refreshToken;
        await this.saveRefresh(r.refreshToken);
        this.setAccess(r.accessToken);
        return r.accessToken;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}
