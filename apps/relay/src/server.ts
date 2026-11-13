/**
 * Relay HTTP + WSS sunucusu (Fastify). TLS, önündeki ters vekil sunucuda (Caddy) sonlanır;
 * bu süreç yalnızca iç ağda dinler (ARCHITECTURE.md §8, FAZ1-PLAN §9).
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { fromB64, verify } from "@saklaz/crypto";
import { canonicalBytes, B64_32, B64_64, DeviceId } from "@saklaz/protocol";
import { Accounts, AuthError } from "./accounts.js";
import { auditMeta, type Pool } from "./db.js";
import { Hub, type PushNotifier } from "./hub.js";

export interface RelayOptions {
  pool: Pool;
  accounts: Accounts;
  relayId: string;
  push: PushNotifier;
  now?: () => number;
  /** Kimlik doğrulama uçları için IP başına dakikalık istek sınırı (varsayılan 30). */
  authRatePerMinute?: number;
  /**
   * X-Forwarded-For'a güven: sayı = önündeki ters vekil sayısı (Caddy arkasında 1), false = hiç.
   * Varsayılan true (Sprint 2 davranışı; testler doğrudan bağlanır). Üretim giriş noktası
   * (main.ts) bunu her zaman açıkça ayarlar; doğrudan açılan bir relay'de istemci IP'si taklit
   * edilip hız sınırı atlatılamasın diye 0 kullanılır.
   */
  trustProxy?: boolean | number;
  /** Fastify günlük ayarı (varsayılan kapalı). İstek gövdesi ve başlıkları günlüğe yazılmaz. */
  logger?: false | { level: string };
  /** Hazır olma denetimi (/readyz). Verilmezse /readyz her zaman 200 döner. */
  ready?: () => Promise<boolean>;
}

const Register = z.strictObject({ email: z.email().max(254), password: z.string().min(12).max(256) });
const Login = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) });
const Refresh = z.strictObject({ refreshToken: z.string().min(10).max(200) });
const DeviceReg = z.strictObject({
  deviceId: DeviceId,
  kind: z.enum(["phone", "computer"]),
  signPub: B64_32,
  /** Cihazın anahtar sahipliği kanıtı: SAKLAZ-v1/relay-auth alanında {deviceId, signPub, accountId} imzası. */
  proof: B64_64,
});

/** Sayı verilirse: yalnızca soketten itibaren o kadar sekmeye (ters vekile) güvenilir. */
function trustProxyOption(t: boolean | number | undefined): boolean | ((addr: string, hop: number) => boolean) {
  if (t === undefined) return true;
  if (typeof t === "boolean") return t;
  const hops = t;
  return (_addr, hop) => hop < hops;
}

/** pg ve Node ağ hataları: veritabanı bağlantısı yok veya koptu. */
export function isDbUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006"].includes(code)) return true;
  const m = typeof e.message === "string" ? e.message : "";
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(m);
}

/** IP başına basit sabit pencere sınırlayıcı (kimlik doğrulama uçları için). */
class IpLimiter {
  private readonly m = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  hit(ip: string): boolean {
    const t = this.now();
    const e = this.m.get(ip);
    if (!e || t - e.start >= this.windowMs) {
      this.m.set(ip, { start: t, n: 1 });
      return true;
    }
    e.n++;
    return e.n <= this.limit;
  }
}

export function buildRelay(o: RelayOptions): { app: FastifyInstance; hub: Hub } {
  const now = o.now ?? Date.now;
  const app = Fastify({
    logger: o.logger
      ? {
          level: o.logger.level,
          // Yalnızca yöntem, yol ve durum kodu. Başlıklar (Authorization), gövde (parola, TOTP kodu)
          // ve sorgu dizgisi günlüğe girmez.
          serializers: {
            req: (r: FastifyRequest) => ({ method: r.method, route: r.routeOptions.url ?? "?" }),
            res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
          },
        }
      : false,
    bodyLimit: 64 * 1024,
    trustProxy: trustProxyOption(o.trustProxy),
  });
  const hub = new Hub(o.pool, o.accounts, { relayId: o.relayId, push: o.push, now });
  const authLimiter = new IpLimiter(o.authRatePerMinute ?? 30, 60_000, now);

  app.addHook("onSend", (_req, reply, payload, done) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", "no-store");
    done(null, payload);
  });

  const authErr = (e: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (e instanceof AuthError) {
      const status = e.code === "LOCKED" ? 423 : e.code === "EMAIL_TAKEN" ? 409 : e.code === "WEAK_PASSWORD" ? 400 : 401;
      // Kimlik bilgisi hatalarında ayrıntı verilmez (MFA mı parola mı ayrımı sızdırılmaz).
      const code = e.code === "MFA_INVALID" ? "INVALID_CREDENTIALS" : e.code;
      return reply.code(status).send({ error: code });
    }
    throw e;
  };

  // Canlılık: süreç ayakta ve olay döngüsü çalışıyor. Konteyner sağlık denetimi bunu kullanır.
  app.get("/healthz", () => ({ ok: true }));
  // Hazır olma: veritabanına ulaşılabiliyor. Veritabanı kopuksa 503; süreç ÇÖKMEZ ve bağlantı
  // geri gelince kendiliğinden toparlanır.
  app.get("/readyz", async (_req, reply) => {
    const ok = o.ready ? await o.ready() : true;
    return reply.code(ok ? 200 : 503).send({ ok });
  });

  // Beklenmeyen hatalarda istemciye ayrıntı verilmez (veritabanı hata metni, yığın izi, iç adresler
  // sızmaz). Veritabanına ulaşılamıyorsa 503, diğer durumlarda 500.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "BAD_REQUEST" });
    }
    const unavailable = isDbUnavailable(err);
    req.log.error({ err: { name: err.name, code: err.code ?? null } }, unavailable ? "veritabanı kullanılamıyor" : "beklenmeyen hata");
    return reply.code(unavailable ? 503 : 500).send({ error: unavailable ? "UNAVAILABLE" : "INTERNAL" });
  });

  app.post("/v1/accounts", async (req, reply) => {
    if (!authLimiter.hit(req.ip)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const b = Register.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "SCHEMA" });
    try {
      const created = await o.accounts.register(b.data.email, b.data.password);
      return await reply.code(201).send(created);
    } catch (e) {
      return authErr(e, reply);
    }
  });

  app.post("/v1/auth/login", async (req, reply) => {
    if (!authLimiter.hit(req.ip)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const b = Login.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "SCHEMA" });
    try {
      return await o.accounts.login(b.data.email, b.data.password, b.data.code);
    } catch (e) {
      return authErr(e, reply);
    }
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    if (!authLimiter.hit(req.ip)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const b = Refresh.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "SCHEMA" });
    try {
      return await o.accounts.refresh(b.data.refreshToken);
    } catch (e) {
      return authErr(e, reply);
    }
  });

  const bearer = async (h: string | undefined): Promise<string> => {
    if (!h?.startsWith("Bearer ")) throw new AuthError("TOKEN_INVALID");
    return o.accounts.verifyAccess(h.slice(7));
  };

  app.post("/v1/devices", async (req, reply) => {
    let accountId: string;
    try {
      accountId = await bearer(req.headers.authorization);
    } catch (e) {
      return authErr(e, reply);
    }
    const b = DeviceReg.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "SCHEMA" });
    const ok = verify(
      "SAKLAZ-v1/relay-auth",
      canonicalBytes({ deviceId: b.data.deviceId, signPub: b.data.signPub, accountId }),
      fromB64(b.data.proof),
      fromB64(b.data.signPub),
    );
    if (!ok) return reply.code(400).send({ error: "PROOF_INVALID" });
    const r = await o.pool.query(
      "INSERT INTO devices (device_id, account_id, kind, sign_pub) VALUES ($1, $2, $3, $4) ON CONFLICT (device_id) DO NOTHING",
      [b.data.deviceId, accountId, b.data.kind, b.data.signPub],
    );
    if (r.rowCount === 0) return reply.code(409).send({ error: "DEVICE_EXISTS" });
    await auditMeta(o.pool, { accountId, actor: b.data.deviceId, action: "device.registered", details: { kind: b.data.kind } });
    return reply.code(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/v1/devices/:id/disable", async (req, reply) => {
    let accountId: string;
    try {
      accountId = await bearer(req.headers.authorization);
    } catch (e) {
      return authErr(e, reply);
    }
    const r = await o.pool.query("UPDATE devices SET disabled = true WHERE device_id = $1 AND account_id = $2", [req.params.id, accountId]);
    if (r.rowCount === 0) return reply.code(404).send({ error: "NOT_FOUND" });
    hub.disconnect(req.params.id);
    await auditMeta(o.pool, { accountId, actor: "account", action: "device.disabled", details: { deviceId: req.params.id } });
    return { ok: true };
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 400 * 1024 });
  app.server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/connect") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.handle(ws);
    });
  });
  app.addHook("onClose", (_i, done) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => {
      done();
    });
  });

  return { app, hub };
}
