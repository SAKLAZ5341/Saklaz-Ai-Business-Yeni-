/**
 * Relay HTTP + WSS sunucusu (Fastify). TLS, önündeki ters vekil sunucuda (Caddy) sonlanır;
 * bu süreç yalnızca iç ağda dinler (ARCHITECTURE.md §8, FAZ1-PLAN §9).
 */
import Fastify, { type FastifyInstance } from "fastify";
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
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
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

  app.get("/healthz", () => ({ ok: true }));

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
