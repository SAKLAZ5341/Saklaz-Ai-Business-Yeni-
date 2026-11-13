/**
 * Ajan servisi (MVP alfa): profil klasörü, şifreli kasa, relay girişi, eşleştirme ve komut çalıştırma.
 *
 * Profil = çalışma alanı izolasyonu: "personal" ve "business" profilleri ayrı klasör, ayrı KEK dosyası,
 * ayrı kasa, ayrı veritabanı, ayrı relay hesabı ve ayrı cihaz kimliği kullanır. Bir profilin hiçbir
 * verisi diğerinden okunmaz.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { RelayApi, TokenManager, connectUrl, encodePairingQr, type PairingQr } from "@saklaz/client-core";
import { AgentCore } from "../core.js";
import { ProtectedKeyStore } from "../keystore.js";
import { DpapiUserProtector } from "../protectors/dpapi.js";
import type { KeyProtector } from "../protectors/types.js";
import { RelayClient } from "../transport.js";
import { InsecureFileVault, type SecretVault } from "../vault.js";
import { runCommand } from "./commands.js";
import { EncryptedFileVault } from "./filevault.js";
import type { Logger } from "./logger.js";

export const PROFILES = ["personal", "business"] as const;
export type Profile = (typeof PROFILES)[number];

export interface ProfileConfig {
  v: 1;
  profile: Profile;
  relayUrl: string;
  label: string;
}

export function isProfile(p: string): p is Profile {
  return (PROFILES as readonly string[]).includes(p);
}

export function profileDir(profile: Profile, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env["SAKLAZ_AGENT_HOME"]) return join(env["SAKLAZ_AGENT_HOME"], `agent-${profile}`);
  if (platform === "win32") {
    const base = env["LOCALAPPDATA"];
    if (!base) throw new Error("LOCALAPPDATA tanımlı değil");
    return win32.join(base, "SAKLAZ", `agent-${profile}`);
  }
  return join(homedir(), ".saklaz", `agent-${profile}`);
}

export function validateRelayUrl(url: string, allowInsecure: boolean): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("RELAY_URL_INVALID");
  }
  if (u.protocol === "wss:") return `wss://${u.host}`;
  if (u.protocol === "ws:" && allowInsecure) return `ws://${u.host}`;
  throw new Error(u.protocol === "ws:" ? "RELAY_URL_INSECURE" : "RELAY_URL_INVALID");
}

/**
 * Kasa: Windows'ta DPAPI (kullanıcı kapsamı) ile korunan KEK + şifreli dosya. Diğer platformlarda
 * yalnızca geliştirme/test için SAKLAZ_INSECURE_VAULT=1 ile güvensiz dosya kasası (açıkça belirtilir).
 */
export function openVault(dir: string, profile: Profile, protector?: KeyProtector): { vault: SecretVault; wipe: () => void } {
  let p = protector;
  if (!p && process.platform === "win32") p = new DpapiUserProtector();
  if (!p) return { vault: new InsecureFileVault(join(dir, "vault.insecure.json")), wipe: () => undefined };
  const { kek } = ProtectedKeyStore.openOrCreate(join(dir, "kek.bin"), p);
  const vault = new EncryptedFileVault(join(dir, "vault.bin"), kek, profile);
  return { vault, wipe: () => kek.fill(0) };
}

const REFRESH = "relay-refresh";
const ACCOUNT = "relay-account";

export interface ServiceOptions {
  profile: Profile;
  dir?: string;
  protector?: KeyProtector;
  log: Logger;
  allowInsecureRelay?: boolean;
  now?: () => number;
}

export class AgentService {
  readonly dir: string;
  readonly core: AgentCore;
  private readonly vault: SecretVault;
  private readonly wipeKek: () => void;
  private client: RelayClient | undefined;
  private tokens: TokenManager | undefined;
  private cfg: ProfileConfig | undefined;
  private lastPairQr: PairingQr | undefined;

  constructor(private readonly o: ServiceOptions) {
    this.dir = o.dir ?? profileDir(o.profile);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const v = openVault(this.dir, o.profile, o.protector);
    this.vault = v.vault;
    this.wipeKek = v.wipe;
    const cfgPath = join(this.dir, "config.json");
    if (existsSync(cfgPath)) this.cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as ProfileConfig;
    this.core = new AgentCore({
      dbPath: join(this.dir, "agent.db"),
      vault: this.vault,
      label: this.cfg?.label ?? "Bilgisayar",
      ...(o.now ? { now: o.now } : {}),
      onLockdown: () => {
        this.o.log("warn", "lockdown.engaged");
        this.client?.stop();
      },
      onCommand: (from, body) => {
        // Çekirdeğin ürettiği ack/"received" yanıtları önce gönderilmeli: Noise taşıması sıralıdır ve
        // sonraki bir mesaj önce giderse karşı taraf oturumu sıfırlar. Bu yüzden çalıştırma ertelenir.
        setImmediate(() => {
          void this.execute(from, body.taskId, body.text);
        });
      },
    });
    this.o.log("info", "agent.open", { profile: o.profile, vault: this.vault.kind, deviceId: this.core.deviceId, paired: !!this.core.workspaceId });
  }

  get config(): ProfileConfig | undefined {
    return this.cfg;
  }

  get isLoggedIn(): boolean {
    return !!this.vault.get(REFRESH);
  }

  get isReady(): boolean {
    return !!this.client?.isReady;
  }

  /** Yapılandırma: relay adresi ve görünen ad (gizli değer içermez). */
  configure(relayUrl: string, label: string): ProfileConfig {
    const cfg: ProfileConfig = {
      v: 1,
      profile: this.o.profile,
      relayUrl: validateRelayUrl(relayUrl, this.o.allowInsecureRelay ?? false),
      label: label.trim().slice(0, 64) || "Bilgisayar",
    };
    writeFileSync(join(this.dir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    this.cfg = cfg;
    return cfg;
  }

  private api(): RelayApi {
    if (!this.cfg) throw new Error("NOT_CONFIGURED");
    return new RelayApi(this.cfg.relayUrl);
  }

  /** Hesap girişi (parola + TOTP). Yenileme token'ı yalnızca şifreli kasada saklanır. */
  async login(email: string, password: string, code: string): Promise<void> {
    const api = this.api();
    const r = await api.login(email, password, code);
    await api.registerDevice(r.accessToken, r.accountId, this.core.deviceId, "computer", this.core.sign);
    this.vault.set(REFRESH, new TextEncoder().encode(r.refreshToken));
    this.vault.set(ACCOUNT, new TextEncoder().encode(r.accountId));
    this.tokens = this.newTokens(r.refreshToken);
    this.tokens.setAccess(r.accessToken);
    this.o.log("info", "relay.login", { deviceId: this.core.deviceId });
  }

  private newTokens(refresh: string): TokenManager {
    return new TokenManager(this.api(), refresh, (t) => {
      this.vault.set(REFRESH, new TextEncoder().encode(t));
    });
  }

  /** Relay'e bağlanır; gelen çerçeveler çekirdekte doğrulanır, yanıtlar gönderilir. */
  connect(): RelayClient {
    if (!this.cfg) throw new Error("NOT_CONFIGURED");
    const refresh = this.vault.get(REFRESH);
    if (!refresh) throw new Error("NOT_LOGGED_IN");
    this.tokens ??= this.newTokens(new TextDecoder().decode(refresh));
    const tokens = this.tokens;
    const client = new RelayClient({
      url: connectUrl(this.cfg.relayUrl),
      deviceId: this.core.deviceId,
      sign: this.core.sign,
      getToken: () => tokens.get(),
      maxBackoffMs: 60_000,
      onFrames: (frames) => {
        const r = this.core.processIncoming(frames);
        for (const x of r.rejected) this.o.log("warn", "msg.rejected", { code: x.code });
        for (const m of r.accepted) this.o.log("info", "msg.accepted", { type: m.hdr.type });
        client.send(r.out);
      },
      onState: (s) => {
        this.o.log(s === "error" ? "warn" : "info", "relay.state", { state: s });
      },
    });
    this.client = client;
    if (!this.core.lockdown.locked) client.start();
    return client;
  }

  private async execute(from: string, taskId: string, text: string): Promise<void> {
    const send = (outs: ReturnType<AgentCore["sendTo"]>) => this.client?.send(outs);
    send(this.core.sendTo(from, "task.event", { taskId, seq: 1, status: "running" }));
    const r = await runCommand(text);
    this.o.log(r.ok ? "info" : "warn", "command.done", { name: r.name, ok: r.ok, code: r.code ?? null });
    send(
      this.core.sendTo(from, "task.event", {
        taskId,
        seq: 2,
        status: r.ok ? "succeeded" : "failed",
        summary: r.summary,
        ...(r.ok ? {} : { error: { code: r.code ?? "COMMAND_FAILED", message: r.code === "NOT_ALLOWED" ? "İzin verilmeyen komut" : "Komut başarısız" } }),
      }),
    );
  }

  /** Eşleştirme kodu (QR içeriği). Sır yalnızca bu kodda bulunur. */
  startPairing(): string {
    const p = this.core.startPairing();
    this.lastPairQr = { ...p, ...(this.cfg ? { relay: this.cfg.relayUrl } : {}) };
    this.o.log("info", "pairing.started");
    return encodePairingQr(this.lastPairQr);
  }

  async waitForSas(timeoutMs = 5 * 60_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = this.core.pairingSas();
      if (s) return s;
      if (Date.now() > end) throw new Error("PAIRING_TIMEOUT");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Kullanıcı SAS'ın iki ekranda aynı olduğunu bu bilgisayarda onaylar. */
  confirmPairing(matches: boolean): boolean {
    const out = this.core.confirmPairing(matches);
    if (!out) return false;
    this.client?.send([out]);
    this.o.log("info", "pairing.confirmed");
    return true;
  }

  /** Telefonun sahip bağı (link.set) gelene kadar bekler. */
  async waitLinked(timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    const phoneHas = () => {
      const st = this.core.rosterLog?.current;
      if (!st) return false;
      return [...st.links.keys()].some((k) => k.endsWith(`|${this.core.deviceId}`));
    };
    while (!phoneHas()) {
      if (Date.now() > end) throw new Error("LINK_TIMEOUT");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  close(): void {
    this.client?.stop();
    this.core.close();
    this.wipeKek();
  }
}
