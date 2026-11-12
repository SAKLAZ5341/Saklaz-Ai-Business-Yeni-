/**
 * WSS merkezi — kör aktarıcı.
 *
 * Bağlantı yaşam döngüsü:
 *   auth (erişim token'ı) → challenge (rastgele nonce) → auth.proof (cihaz imzası) → ready
 * Kimlik doğrulama tamamlanmadan başka çerçeve gelirse bağlantı kapatılır.
 *
 * Yönlendirme kuralları:
 *   • Zarf yalnızca AYNI hesaptaki ve devre dışı bırakılmamış bir cihaza gönderilebilir.
 *   • Relay `ct` alanını çözemez; yalnızca saklar ve iletir. Kuyruktaki zarf en çok ttlSec kadar bekler.
 *   • Teslim, alıcının "delivered" onayıyla tamamlanır; ondan sonra zarf silinir.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import { fromB64, toB64, verify } from "@saklaz/crypto";
import { canonicalBytes, ClientFrameSchema, relayAuthPayload, type ServerFrame } from "@saklaz/protocol";
import type { Accounts } from "./accounts.js";
import { auditMeta, type Pool } from "./db.js";

export interface PushNotifier {
  /** İçeriksiz uyandırma sinyali (karar D3). Yalnızca cihaz kimliği verilir. */
  wake(deviceId: string): Promise<void>;
}

/** WebSocket yükünü UTF-8 metne çevirir (Buffer, ArrayBuffer veya parça dizisi olabilir). */
function rawToString(d: RawData): string {
  if (Buffer.isBuffer(d)) return d.toString("utf8");
  if (Array.isArray(d)) return Buffer.concat(d).toString("utf8");
  return Buffer.from(d).toString("utf8");
}

export class RecordingPush implements PushNotifier {
  readonly calls: string[] = [];
  wake(deviceId: string): Promise<void> {
    this.calls.push(deviceId);
    return Promise.resolve();
  }
}

export interface HubConfig {
  relayId: string;
  now?: () => number;
  push: PushNotifier;
  maxQueuedPerDevice?: number;
  maxFramesPerSecond?: number;
  authTimeoutMs?: number;
}

interface Conn {
  /** Çerçeveler bağlantı başına SIRAYLA işlenir; Noise taşıma katmanı sıralı teslim gerektirir. */
  chain: Promise<void>;
  /** Bu bağlantıda gönderilmiş ama teslim onayı henüz gelmemiş zarflar (aynı bağlantıda yinelenmesin). */
  inflight: Set<string>;
  ws: WebSocket;
  state: "new" | "challenged" | "ready";
  accountId?: string;
  deviceId?: string;
  nonce?: string;
  windowStart: number;
  frames: number;
}

export class Hub {
  private readonly online = new Map<string, Conn>();
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly accounts: Accounts,
    private readonly cfg: HubConfig,
  ) {
    this.now = cfg.now ?? Date.now;
  }

  isOnline(deviceId: string): boolean {
    return this.online.has(deviceId);
  }

  handle(ws: WebSocket): void {
    const c: Conn = { chain: Promise.resolve(), inflight: new Set(), ws, state: "new", windowStart: this.now(), frames: 0 };
    const timer = setTimeout(() => {
      if (c.state !== "ready") ws.close(4001, "auth timeout");
    }, this.cfg.authTimeoutMs ?? 10_000);
    ws.on("message", (data, isBinary) => {
      // Sıra garantisi: bir önceki çerçevenin işi (veritabanı yazımı dahil) bitmeden sonraki başlamaz.
      // Aksi halde bir el sıkışma yanıtı ile ardından gelen şifreli mesaj kuyrukta ters sıraya girebilir
      // (Sprint 2 uçtan uca testinde bulundu).
      c.chain = c.chain
        .then(() => this.onMessage(c, data, isBinary))
        .catch(() => {
          this.sendFrame(c, { t: "error", code: "INTERNAL" });
          ws.close(1011, "internal");
        });
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (c.deviceId && this.online.get(c.deviceId) === c) {
        this.online.delete(c.deviceId);
        void this.pool.query("UPDATE devices SET last_seen_at = now() WHERE device_id = $1", [c.deviceId]).catch(() => undefined);
      }
    });
  }

  private sendFrame(c: Conn, f: ServerFrame): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(f));
  }

  private fail(c: Conn, code: string, close = true): void {
    this.sendFrame(c, { t: "error", code });
    if (close) c.ws.close(4000, code);
  }

  private async onMessage(c: Conn, data: unknown, isBinary: boolean): Promise<void> {
    // Hız sınırı (bağlantı başına saniyelik pencere)
    const t = this.now();
    if (t - c.windowStart >= 1000) {
      c.windowStart = t;
      c.frames = 0;
    }
    if (++c.frames > (this.cfg.maxFramesPerSecond ?? 50)) { this.fail(c, "RATE_LIMITED"); return; }
    if (isBinary) { this.fail(c, "SCHEMA"); return; }
    let json: unknown;
    try {
      json = JSON.parse(rawToString(data as RawData));
    } catch {
      this.fail(c, "SCHEMA"); return;
    }
    const p = ClientFrameSchema.safeParse(json);
    if (!p.success) { this.fail(c, "SCHEMA"); return; }
    const f = p.data;

    if (c.state === "new") {
      if (f.t !== "auth") { this.fail(c, "AUTH_REQUIRED"); return; }
      let accountId: string;
      try {
        accountId = await this.accounts.verifyAccess(f.token);
      } catch {
        await auditMeta(this.pool, { accountId: null, actor: f.deviceId, action: "device.auth_failed", details: { stage: "token" } });
        this.fail(c, "AUTH_FAILED"); return;
      }
      const d = await this.pool.query<{ account_id: string; disabled: boolean }>("SELECT account_id, disabled FROM devices WHERE device_id = $1", [f.deviceId]);
      const row = d.rows[0];
      if (!row || row.account_id !== accountId || row.disabled) {
        await auditMeta(this.pool, { accountId, actor: f.deviceId, action: "device.auth_failed", details: { stage: "device" } });
        this.fail(c, "AUTH_FAILED"); return;
      }
      c.accountId = accountId;
      c.deviceId = f.deviceId;
      c.nonce = toB64(randomBytes(32));
      c.state = "challenged";
      this.sendFrame(c, { t: "challenge", nonce: c.nonce, relayId: this.cfg.relayId }); return;
    }

    if (c.state === "challenged") {
      if (f.t !== "auth.proof" || !c.deviceId || !c.nonce || !c.accountId) { this.fail(c, "AUTH_REQUIRED"); return; }
      const d = await this.pool.query<{ sign_pub: string }>("SELECT sign_pub FROM devices WHERE device_id = $1", [c.deviceId]);
      const pub = d.rows[0]?.sign_pub;
      const ok =
        !!pub &&
        verify("SAKLAZ-v1/relay-auth", canonicalBytes(relayAuthPayload(c.deviceId, c.nonce, this.cfg.relayId)), fromB64(f.sig), fromB64(pub));
      if (!ok) {
        await auditMeta(this.pool, { accountId: c.accountId, actor: c.deviceId, action: "device.auth_failed", details: { stage: "proof" } });
        this.fail(c, "AUTH_FAILED"); return;
      }
      c.state = "ready";
      const prev = this.online.get(c.deviceId);
      if (prev && prev !== c) prev.ws.close(4002, "replaced");
      this.online.set(c.deviceId, c);
      await this.pool.query("UPDATE devices SET last_seen_at = now() WHERE device_id = $1", [c.deviceId]);
      await auditMeta(this.pool, { accountId: c.accountId, actor: c.deviceId, action: "device.connected", details: {} });
      const q = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM envelopes WHERE to_device = $1 AND expires_at > now()", [c.deviceId]);
      this.sendFrame(c, { t: "ready", deviceId: c.deviceId, queued: Number(q.rows[0]?.n ?? 0) });
      await this.flush(c);
      return;
    }

    // ready
    const accountId = c.accountId ?? "";
    const self = c.deviceId ?? "";
    switch (f.t) {
      case "send": {
        const to = await this.pool.query<{ account_id: string; disabled: boolean }>("SELECT account_id, disabled FROM devices WHERE device_id = $1", [f.to]);
        const row = to.rows[0];
        // Başka hesaptaki veya bilinmeyen cihaz için aynı hata (varlık sızdırmamak için).
        if (!row || row.account_id !== accountId || row.disabled || f.to === self) { this.fail(c, "NO_ROUTE", false); return; }
        const queued = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM envelopes WHERE to_device = $1", [f.to]);
        if (Number(queued.rows[0]?.n ?? 0) >= (this.cfg.maxQueuedPerDevice ?? 10_000)) { this.fail(c, "QUEUE_FULL", false); return; }
        await this.pool.query(
          "INSERT INTO envelopes (id, account_id, from_device, to_device, kind, ct, size, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8)) ON CONFLICT (id) DO NOTHING",
          [f.id, accountId, self, f.to, f.kind, f.ct, f.ct.length, f.ttlSec],
        );
        this.sendFrame(c, { t: "accepted", id: f.id });
        const dest = this.online.get(f.to);
        if (dest) await this.flush(dest);
        else await this.cfg.push.wake(f.to);
        return;
      }
      case "delivered": {
        c.inflight.delete(f.id);
        await this.pool.query("DELETE FROM envelopes WHERE id = $1 AND to_device = $2", [f.id, self]);
        return;
      }
      case "presence.query": {
        const r = await this.pool.query<{ device_id: string; last_seen_at: Date | null }>(
          "SELECT device_id, last_seen_at FROM devices WHERE account_id = $1 AND device_id = ANY($2)",
          [accountId, f.deviceIds],
        );
        this.sendFrame(c, {
          t: "presence",
          items: r.rows.map((x) => ({ deviceId: x.device_id, online: this.online.has(x.device_id), lastSeen: x.last_seen_at ? x.last_seen_at.getTime() : null })),
        });
        return;
      }
      case "ping":
        this.sendFrame(c, { t: "pong" });
        return;
      default:
        { this.fail(c, "UNEXPECTED"); return; }
    }
  }

  /** Bekleyen zarfları sırayla iletir. Silme, alıcının "delivered" onayıyla olur. */
  private async flush(c: Conn): Promise<void> {
    if (!c.deviceId) return;
    const r = await this.pool.query<{ id: string; from_device: string; kind: "sealed" | "hs1" | "hs2" | "noise" | "pair"; ct: string; created_at: Date }>(
      "SELECT id, from_device, kind, ct, created_at FROM envelopes WHERE to_device = $1 AND expires_at > now() ORDER BY seq LIMIT 500",
      [c.deviceId],
    );
    for (const e of r.rows) {
      // Aynı bağlantıda yinelenen teslim yapılmaz (Sprint 2 uçtan uca testinde bulundu). Bağlantı koparsa
      // onaylanmamış zarflar yeni bağlantıda yeniden iletilir: en az bir kez teslim.
      if (c.inflight.has(e.id)) continue;
      c.inflight.add(e.id);
      this.sendFrame(c, { t: "deliver", id: e.id, from: e.from_device, kind: e.kind, ct: e.ct, sentAt: e.created_at.getTime() });
    }
  }

  /** Süresi dolmuş zarfları siler (zamanlanmış iş). */
  async sweepExpired(): Promise<number> {
    const r = await this.pool.query("DELETE FROM envelopes WHERE expires_at <= now()");
    return r.rowCount ?? 0;
  }

  /** Bir cihazı relay düzeyinde devre dışı bırakır ve bağlantısını keser (asıl güven kökü cihazlardadır). */
  disconnect(deviceId: string): void {
    this.online.get(deviceId)?.ws.close(4003, "disabled");
  }

  newEnvelopeId(): string {
    return randomUUID();
  }
}
