/**
 * Uygulama durumu (arayüzden bağımsız; testlerde doğrudan sınanır).
 *
 * Profil = çalışma alanı. Kişisel ve kurumsal profiller ayrı relay, ayrı hesap, ayrı cihaz kimliği,
 * ayrı anahtarlar ve ayrı yerel veri (not, görev, sohbet, AI ayarı) kullanır. Aynı anda yalnızca etkin
 * profilin bağlantısı açıktır; profil değişince öncekinin bağlantısı kapatılır.
 */
import { initCrypto } from "@saklaz/crypto";
import {
  connectUrl,
  decodePairingQr,
  PhoneClient,
  RelayApi,
  RelayConnection,
  TokenManager,
  type Computer,
  type PairingQr,
  type PhoneState,
  type PresenceItem,
  type RelayState,
} from "@saklaz/client-core";
import type { InnerMessage, WireOut } from "@saklaz/protocol";
import type { Host } from "./host.js";

export type ProfileKind = "personal" | "business";

export interface ProfileMeta {
  id: string;
  name: string;
  kind: ProfileKind;
  relayUrl: string;
  email: string;
  /** Yalnızca yerel ağ testi: ws:// (TLS'siz). Uçtan uca şifreleme sürer ama oturum token'ı ağda açıktır. */
  insecure: boolean;
}

export interface TaskView {
  taskId: string;
  deviceId: string;
  text: string;
  status: string;
  summary?: string;
  errorCode?: string;
  ts: number;
}

export interface NoteItem {
  id: string;
  text: string;
  ts: number;
}
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  due?: string;
}

export function hostFetch(host: Host) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const r = await host.http(url, init.method, init.headers, init.body);
    return { status: r.status, json: () => Promise.resolve(r.body ? (JSON.parse(r.body) as unknown) : {}) };
  };
}

export function validateRelay(url: string, insecure: boolean): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error("RELAY_URL_INVALID");
  }
  if (u.protocol === "wss:" || (u.protocol === "ws:" && insecure)) return `${u.protocol}//${u.host}`;
  throw new Error(u.protocol === "ws:" ? "RELAY_URL_INSECURE" : "RELAY_URL_INVALID");
}

const key = (p: string, k: string) => `p:${p}:${k}`;

export class Store {
  constructor(readonly host: Host) {}
  async json<T>(k: string, fallback: T): Promise<T> {
    const v = await this.host.get(k);
    if (v === null) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  put(k: string, v: unknown): Promise<void> {
    return this.host.set(k, JSON.stringify(v));
  }
  profiles(): Promise<ProfileMeta[]> {
    return this.json<ProfileMeta[]>("profiles", []);
  }
  async saveProfile(m: ProfileMeta): Promise<void> {
    const all = (await this.profiles()).filter((p) => p.id !== m.id);
    await this.put("profiles", [...all, m]);
  }
  async deleteProfile(id: string): Promise<void> {
    await this.put("profiles", (await this.profiles()).filter((p) => p.id !== id));
    for (const k of ["state", "refresh", "notes", "todos", "chat", "ai", "aikey", "tasks"]) await this.host.remove(key(id, k));
    if ((await this.host.get("active")) === id) await this.host.remove("active");
  }
  pget<T>(p: string, k: string, fallback: T) {
    return this.json(key(p, k), fallback);
  }
  pput(p: string, k: string, v: unknown) {
    return this.put(key(p, k), v);
  }
  async secret(p: string, k: string): Promise<string | null> {
    return this.host.get(key(p, k));
  }
  setSecret(p: string, k: string, v: string) {
    return this.host.set(key(p, k), v);
  }
}

/** Hesap oluşturma: TOTP kurulum adresini döndürür (doğrulama uygulamasına eklenir). */
export async function registerAccount(host: Host, relayUrl: string, insecure: boolean, email: string, password: string): Promise<string> {
  await initCrypto();
  const api = new RelayApi(validateRelay(relayUrl, insecure), hostFetch(host));
  return (await api.register(email.trim(), password)).otpauth;
}

/** Yeni profil: giriş (parola + TOTP), yeni çalışma alanı ve telefon kimliği, cihaz kaydı. */
export async function createProfile(
  store: Store,
  input: { name: string; kind: ProfileKind; relayUrl: string; insecure: boolean; email: string; password: string; code: string },
): Promise<ProfileMeta> {
  await initCrypto();
  const relayUrl = validateRelay(input.relayUrl, input.insecure);
  const api = new RelayApi(relayUrl, hostFetch(store.host));
  const login = await api.login(input.email.trim(), input.password, input.code.trim());
  const phone = PhoneClient.createWorkspace({ label: input.kind === "business" ? "Telefon (kurumsal)" : "Telefon" });
  await api.registerDevice(login.accessToken, login.accountId, phone.id, "phone", phone.sign);
  const meta: ProfileMeta = {
    id: phone.ws,
    name: input.name.trim().slice(0, 40) || (input.kind === "business" ? "Kurumsal" : "Kişisel"),
    kind: input.kind,
    relayUrl,
    email: input.email.trim(),
    insecure: input.insecure,
  };
  await store.pput(meta.id, "state", phone.exportState());
  await store.setSecret(meta.id, "refresh", login.refreshToken);
  await store.saveProfile(meta);
  await store.host.set("active", meta.id);
  return meta;
}

export interface PairingProgress {
  qr: PairingQr;
  sas: string;
  label: string;
  done: boolean;
  error?: string;
}

/** Etkin profil oturumu: relay bağlantısı, bilgisayarlar, komutlar. */
export class Session {
  relayState: RelayState = "connecting";
  relayError: string | undefined;
  readonly presence = new Map<string, PresenceItem>();
  tasks: TaskView[] = [];
  pairing: PairingProgress | undefined;
  private conn: RelayConnection;
  private saving: Promise<void> = Promise.resolve();
  private presenceTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly store: Store,
    readonly meta: ProfileMeta,
    readonly phone: PhoneClient,
    refresh: string,
    private readonly onChange: () => void,
  ) {
    const api = new RelayApi(meta.relayUrl, hostFetch(store.host));
    const tokens = new TokenManager(api, refresh, (t) => store.setSecret(meta.id, "refresh", t));
    this.conn = new RelayConnection({
      url: connectUrl(meta.relayUrl),
      deviceId: phone.id,
      sign: phone.sign,
      getToken: () => tokens.get(),
      onFrames: async (frames) => {
        const r = this.phone.receive(frames);
        await this.persist();
        this.conn.send(r.replies);
        for (const m of r.messages) this.onMessage(m);
        if (this.pairing && !this.pairing.done && this.phone.computers().some((c) => c.deviceId === this.pairing?.qr.agentId)) {
          this.pairing.done = true;
          this.queryPresence();
        }
        if (this.pairing && r.errors.some((e) => e.startsWith("PAIR") || e === "AGENT_SIG_INVALID" || e === "NO_PENDING_PAIRING")) {
          this.pairing.error = r.errors.join(",");
        }
        this.onChange();
      },
      onState: (s, code) => {
        this.relayState = s;
        this.relayError = code;
        if (s === "ready") this.queryPresence();
        this.onChange();
      },
      onPresence: (items) => {
        for (const i of items) this.presence.set(i.deviceId, i);
        this.onChange();
      },
    });
  }

  static async open(store: Store, meta: ProfileMeta, onChange: () => void): Promise<Session> {
    await initCrypto();
    const state = await store.pget<PhoneState | null>(meta.id, "state", null);
    const refresh = await store.secret(meta.id, "refresh");
    if (!state || !refresh) throw new Error("PROFILE_INCOMPLETE");
    const s = new Session(store, meta, PhoneClient.restore(state), refresh, onChange);
    s.tasks = await store.pget<TaskView[]>(meta.id, "tasks", []);
    s.conn.start();
    s.presenceTimer = setInterval(() => {
      s.queryPresence();
    }, 30_000);
    return s;
  }

  close(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.conn.stop();
  }

  computers(): Computer[] {
    return this.phone.computers();
  }

  private queryPresence(): void {
    this.conn.queryPresence(this.computers().map((c) => c.deviceId));
  }

  /** Sayaç ve cihaz listesi, mesaj gönderilmeden ÖNCE kalıcı yazılır (yeniden başlatmada sayaç geri gitmez). */
  private persist(): Promise<void> {
    this.saving = this.saving.then(() => this.store.pput(this.meta.id, "state", this.phone.exportState()));
    return this.saving;
  }

  private async sendSafe(outs: WireOut[]): Promise<void> {
    await this.persist();
    this.conn.send(outs);
  }

  private onMessage(m: InnerMessage): void {
    if (m.hdr.type !== "task.event") return;
    const b = m.body as { taskId: string; status: string; summary?: string; error?: { code: string } };
    const t = this.tasks.find((x) => x.taskId === b.taskId && x.deviceId === m.hdr.from);
    if (!t) return;
    const rank = ["received", "running", "succeeded", "failed", "rejected"];
    if (rank.indexOf(b.status) >= rank.indexOf(t.status) || !rank.includes(t.status)) t.status = b.status;
    if (b.summary) t.summary = b.summary;
    if (b.error) t.errorCode = b.error.code;
    void this.store.pput(this.meta.id, "tasks", this.tasks.slice(-100));
  }

  /** QR içeriği (veya elle girilen kod) → SAS. Kullanıcı SAS'ı bilgisayarda karşılaştırıp orada onaylar. */
  async startPairing(text: string, label: string): Promise<PairingProgress> {
    const qr = decodePairingQr(text);
    const req = this.phone.startPairing(qr, label);
    this.pairing = { qr, sas: this.phone.sasFor(qr), label, done: false };
    await this.sendSafe([req]);
    this.onChange();
    return this.pairing;
  }

  async sendCommand(deviceId: string, text: string): Promise<TaskView> {
    const taskId = crypto.randomUUID();
    const outs = this.phone.send(deviceId, "cmd.create", { taskId, text: text.trim().slice(0, 4000) }, { lifetimeMs: 3_600_000 });
    const t: TaskView = { taskId, deviceId, text: text.trim().slice(0, 4000), status: "sent", ts: Date.now() };
    this.tasks.push(t);
    await this.store.pput(this.meta.id, "tasks", this.tasks.slice(-100));
    await this.sendSafe(outs);
    this.onChange();
    return t;
  }

  /** Acil kilit: bilgisayar bu mesajı aldığında bütün komutları reddeder (yalnızca bilgisayarda yerel olarak açılır). */
  async lockdown(deviceId: string): Promise<void> {
    await this.sendSafe(this.phone.send(deviceId, "agent.lockdown", { reason: "telefon" }));
  }

  /** Bilgisayarı kalıcı olarak çıkarır; iptal girişi diğer bilgisayarlara da gönderilir. */
  async revoke(deviceId: string): Promise<void> {
    const others = this.computers().filter((c) => c.deviceId !== deviceId);
    const entry = this.phone.revoke(deviceId);
    const outs = others.flatMap((c) => this.phone.send(c.deviceId, "roster.append", { entries: [entry] as never }));
    await this.sendSafe(outs);
    this.onChange();
  }
}
