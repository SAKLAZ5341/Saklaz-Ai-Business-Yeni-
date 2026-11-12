/**
 * İmzalı cihaz listesi (roster) — ADR-0014, SECURITY.md §18.
 *
 * Her çalışma alanında, yalnızca ekleme yapılabilen ve hash zinciriyle bağlı bir liste.
 * Girişleri yalnızca SAHİP telefonların ONAY anahtarı imzalayabilir (biyometrik doğrulamalı).
 * Relay listeyi saklar ve dağıtır ancak giriş üretemez, sırasını değiştiremez. Bunun dayandığı
 * varsayımlar SECURITY.md §0'dadır.
 *
 * İşlemler:
 *   genesis        — alanı kurar; ilk sahip telefon (kendi onay anahtarıyla imzalar), kurtarma açık anahtarı
 *   device.add     — cihaz ekler; eklenen cihaz da girişi kendi imza anahtarıyla EŞ-İMZALAR (anahtar sahipliği kanıtı)
 *   device.revoke  — cihazı iptal eder; kimliği ve TÜM anahtarları kalıcı yasak listesine girer
 *   link.set       — bir telefon ile bir bilgisayar arasındaki güven bağını ve rolü belirler
 *   link.remove    — bağı kaldırır
 * Kurtarma işlemleri (recovery.*) Sprint 6'dadır; şema adları ayrılmıştır, şimdilik reddedilir.
 */
import { z } from "zod";
import { fromB64, sign, taggedHash, toB64, verify } from "@saklaz/crypto";
import { canonicalBytes } from "./jcs.js";
import { B64_32, B64_64, DeviceId, EpochMs, WorkspaceId } from "./schemas.js";

export class RosterError extends Error {
  constructor(
    readonly code:
      | "ROSTER_SCHEMA"
      | "ROSTER_WS"
      | "ROSTER_SEQ"
      | "ROSTER_GAP"
      | "ROSTER_PREV"
      | "ROSTER_SIGNER"
      | "ROSTER_SIG"
      | "ROSTER_COSIG"
      | "ROSTER_DUP_DEVICE"
      | "ROSTER_DUP_KEY"
      | "ROSTER_KEY_REVOKED"
      | "ROSTER_UNKNOWN_DEVICE"
      | "ROSTER_LAST_OWNER"
      | "ROSTER_KIND"
      | "ROSTER_FORK"
      | "ROSTER_FORKED_LOCKED"
      | "ROSTER_PIN_MISMATCH"
      | "ROSTER_UNSUPPORTED_OP",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RosterError";
  }
}

export const LINK_ROLES = ["owner", "operator", "viewer"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

const Label = z.string().min(1).max(64).refine((s) => s.isWellFormed() && !/[\u0000-\u001F\u007F‪-‮⁦-⁩]/u.test(s)); // eslint-disable-line no-control-regex

export const RosterDeviceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("phone"),
    deviceId: DeviceId,
    label: Label,
    signPub: B64_32,
    /** Ayrı, her kullanımda biyometrik onay anahtarı (ADR-0011). */
    approvalPub: B64_32,
    dhPub: B64_32,
    /** Sahip telefon liste girişi imzalayabilir. */
    owner: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computer"),
    deviceId: DeviceId,
    label: Label,
    signPub: B64_32,
    dhPub: B64_32,
  }),
]);
export type RosterDevice = z.infer<typeof RosterDeviceSchema>;

/** 32 sıfır baytın base64url gösterimi (modül yüklenirken kripto başlatılmamış olabileceği için sabit metin). */
const ZERO_HASH = "A".repeat(43);

const OpBodies = {
  genesis: z.strictObject({
    device: RosterDeviceSchema,
    /** Kağıt kurtarma anahtarının açık anahtarı (ADR-0015); kurulmadıysa null. */
    recoveryPub: B64_32.nullable(),
    policy: z.strictObject({ recoveryDelayHours: z.number().int().min(24).max(168) }),
  }),
  "device.add": z.strictObject({ device: RosterDeviceSchema }),
  "device.revoke": z.strictObject({ deviceId: DeviceId, reason: Label.optional() }),
  "link.set": z.strictObject({ phoneId: DeviceId, computerId: DeviceId, role: z.enum(LINK_ROLES) }),
  "link.remove": z.strictObject({ phoneId: DeviceId, computerId: DeviceId }),
} as const;
export type RosterOp = keyof typeof OpBodies;
const OPS = Object.keys(OpBodies) as RosterOp[];

export const RosterEntrySchema = z.strictObject({
  v: z.literal(1),
  ws: WorkspaceId,
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  prev: B64_32,
  ts: EpochMs,
  op: z.string(),
  body: z.unknown(),
  /** İmzalayan sahip telefonun cihaz kimliği. */
  signer: DeviceId,
  /** Sahibin ONAY anahtarıyla, SAKLAZ-v1/roster alanında imza. */
  sig: B64_64,
  /** device.add için: eklenen cihazın İMZA anahtarıyla eş-imza. */
  cosig: B64_64.optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export interface RosterHead {
  seq: number;
  hash: string;
}

export interface RosterState {
  ws: string;
  head: RosterHead;
  /** seq → giriş özeti (çatallanma tespiti ve eski rh doğrulaması için). */
  hashes: readonly string[];
  devices: ReadonlyMap<string, RosterDevice & { revoked: boolean }>;
  revokedIds: ReadonlySet<string>;
  revokedKeys: ReadonlySet<string>;
  /** `${phoneId}|${computerId}` → rol */
  links: ReadonlyMap<string, LinkRole>;
  recoveryPub: string | null;
  recoveryDelayHours: number;
}

function signingBytes(e: Omit<RosterEntry, "sig" | "cosig">): Uint8Array {
  return canonicalBytes({ v: e.v, ws: e.ws, seq: e.seq, prev: e.prev, ts: e.ts, op: e.op, body: e.body, signer: e.signer });
}

export function rosterEntryHash(e: RosterEntry): string {
  return toB64(taggedHash("SAKLAZ-v1/roster-entry", canonicalBytes(e), 32));
}

function keysOf(d: RosterDevice): string[] {
  return d.kind === "phone" ? [d.signPub, d.approvalPub, d.dhPub] : [d.signPub, d.dhPub];
}

const linkKey = (phoneId: string, computerId: string) => `${phoneId}|${computerId}`;

/**
 * Tek bir girişi doğrular ve yeni durumu döndürür. Önceki durum değiştirilmez.
 * Kurallar sırayla: şema → alan → sıra → önceki özet → imzalayan yetkisi → imza → işleme özgü kurallar.
 */
export function applyRosterEntry(prev: RosterState | undefined, raw: unknown): RosterState {
  const parsed = RosterEntrySchema.safeParse(raw);
  if (!parsed.success) throw new RosterError("ROSTER_SCHEMA");
  const e = parsed.data;
  if (!(OPS as string[]).includes(e.op)) throw new RosterError("ROSTER_UNSUPPORTED_OP");
  const op = e.op as RosterOp;
  const bodyParsed = OpBodies[op].safeParse(e.body);
  if (!bodyParsed.success) throw new RosterError("ROSTER_SCHEMA", "Giriş gövdesi geçersiz.");
  const body = bodyParsed.data;

  if (!prev) {
    // Yalnızca genesis
    if (op !== "genesis" || e.seq !== 0 || e.prev !== ZERO_HASH) throw new RosterError("ROSTER_SEQ", "İlk giriş genesis olmalı.");
    const g = body as z.infer<(typeof OpBodies)["genesis"]>;
    if (g.device.kind !== "phone" || !g.device.owner) throw new RosterError("ROSTER_KIND", "İlk cihaz sahip telefon olmalı.");
    if (e.signer !== g.device.deviceId) throw new RosterError("ROSTER_SIGNER");
    if (!verify("SAKLAZ-v1/roster", signingBytes(e), fromB64(e.sig), fromB64(g.device.approvalPub))) {
      throw new RosterError("ROSTER_SIG");
    }
    const hash = rosterEntryHash(e);
    return {
      ws: e.ws,
      head: { seq: 0, hash },
      hashes: [hash],
      devices: new Map([[g.device.deviceId, { ...g.device, revoked: false }]]),
      revokedIds: new Set(),
      revokedKeys: new Set(),
      links: new Map(),
      recoveryPub: g.recoveryPub,
      recoveryDelayHours: g.policy.recoveryDelayHours,
    };
  }

  if (e.ws !== prev.ws) throw new RosterError("ROSTER_WS");
  if (op === "genesis") throw new RosterError("ROSTER_SEQ", "İkinci genesis kabul edilmez.");
  if (e.seq !== prev.head.seq + 1) throw new RosterError(e.seq > prev.head.seq + 1 ? "ROSTER_GAP" : "ROSTER_SEQ");
  if (e.prev !== prev.head.hash) throw new RosterError("ROSTER_PREV");

  const signer = prev.devices.get(e.signer);
  if (!signer || signer.revoked || signer.kind !== "phone" || !signer.owner) throw new RosterError("ROSTER_SIGNER");
  if (!verify("SAKLAZ-v1/roster", signingBytes(e), fromB64(e.sig), fromB64(signer.approvalPub))) {
    throw new RosterError("ROSTER_SIG");
  }

  const devices = new Map(prev.devices);
  const revokedIds = new Set(prev.revokedIds);
  const revokedKeys = new Set(prev.revokedKeys);
  const links = new Map(prev.links);

  switch (op) {
    case "device.add": {
      const d = (body as z.infer<(typeof OpBodies)["device.add"]>).device;
      if (revokedIds.has(d.deviceId) || keysOf(d).some((k) => revokedKeys.has(k))) {
        throw new RosterError("ROSTER_KEY_REVOKED", "İptal edilmiş kimlik veya anahtar yeniden kullanılamaz.");
      }
      if (devices.has(d.deviceId)) throw new RosterError("ROSTER_DUP_DEVICE");
      const inUse = new Set([...devices.values()].flatMap(keysOf));
      if (keysOf(d).some((k) => inUse.has(k)) || new Set(keysOf(d)).size !== keysOf(d).length) {
        throw new RosterError("ROSTER_DUP_KEY");
      }
      if (!e.cosig || !verify("SAKLAZ-v1/roster", signingBytes(e), fromB64(e.cosig), fromB64(d.signPub))) {
        throw new RosterError("ROSTER_COSIG", "Eklenen cihaz anahtar sahipliğini kanıtlamadı.");
      }
      devices.set(d.deviceId, { ...d, revoked: false });
      break;
    }
    case "device.revoke": {
      const { deviceId } = body as z.infer<(typeof OpBodies)["device.revoke"]>;
      const d = devices.get(deviceId);
      if (!d || d.revoked) throw new RosterError("ROSTER_UNKNOWN_DEVICE");
      const remainingOwners = [...devices.values()].filter(
        (x) => x.kind === "phone" && x.owner && !x.revoked && x.deviceId !== deviceId,
      );
      if (d.kind === "phone" && d.owner && remainingOwners.length === 0) {
        // Son sahibi iptal etmek alanı yönetilemez bırakır. Kurtarma (Sprint 6) bu durumu ayrıca ele alacak.
        throw new RosterError("ROSTER_LAST_OWNER");
      }
      devices.set(deviceId, { ...d, revoked: true });
      revokedIds.add(deviceId);
      for (const k of keysOf(d)) revokedKeys.add(k);
      for (const key of [...links.keys()]) {
        const [p, c] = key.split("|");
        if (p === deviceId || c === deviceId) links.delete(key);
      }
      break;
    }
    case "link.set":
    case "link.remove": {
      const b = body as { phoneId: string; computerId: string; role?: LinkRole };
      const p = devices.get(b.phoneId);
      const c = devices.get(b.computerId);
      if (!p || p.revoked || !c || c.revoked) throw new RosterError("ROSTER_UNKNOWN_DEVICE");
      if (p.kind !== "phone" || c.kind !== "computer") throw new RosterError("ROSTER_KIND");
      if (op === "link.set" && b.role) links.set(linkKey(b.phoneId, b.computerId), b.role);
      else links.delete(linkKey(b.phoneId, b.computerId));
      break;
    }
  }

  if (e.op !== "device.add" && e.cosig !== undefined) throw new RosterError("ROSTER_SCHEMA", "Beklenmeyen eş-imza.");
  const hash = rosterEntryHash(e);
  return {
    ...prev,
    head: { seq: e.seq, hash },
    hashes: [...prev.hashes, hash],
    devices,
    revokedIds,
    revokedKeys,
    links,
  };
}

/** Bir telefonun belirli bir bilgisayardaki rolü (bağ yoksa undefined). */
export function linkRole(state: RosterState, phoneId: string, computerId: string): LinkRole | undefined {
  return state.links.get(linkKey(phoneId, computerId));
}

/**
 * Cihaz listesi kaydı. Girişleri sırayla uygular; aynı sıra numarasında farklı bir giriş görülürse
 * (çatallanma) KİLİTLENİR ve kullanıcı kararı gelene kadar yeni giriş kabul etmez.
 */
export class RosterLog {
  private state: RosterState | undefined;
  private readonly entries: RosterEntry[] = [];
  private forked = false;

  /** Kayıtlı girişlerden yeniden kurar (ajan başlangıcı). Her giriş yeniden doğrulanır. */
  static fromEntries(entries: readonly unknown[], pin?: RosterHead): RosterLog {
    const log = new RosterLog();
    for (const e of entries) log.appendOne(e);
    if (pin && (log.head().seq < pin.seq || log.state?.hashes[pin.seq] !== pin.hash)) {
      throw new RosterError("ROSTER_PIN_MISMATCH");
    }
    return log;
  }

  get current(): RosterState {
    if (!this.state) throw new RosterError("ROSTER_SEQ", "Liste boş.");
    return this.state;
  }

  get isForked(): boolean {
    return this.forked;
  }

  head(): RosterHead {
    return this.state ? this.state.head : { seq: -1, hash: ZERO_HASH };
  }

  all(): readonly RosterEntry[] {
    return this.entries;
  }

  /**
   * @returns "appended" | "known" (aynı giriş zaten var)
   * @throws RosterError — ROSTER_FORK (aynı sırada farklı giriş), ROSTER_GAP (eksik giriş) vb.
   */
  appendOne(raw: unknown): "appended" | "known" {
    if (this.forked) throw new RosterError("ROSTER_FORKED_LOCKED");
    const parsed = RosterEntrySchema.safeParse(raw);
    if (!parsed.success) throw new RosterError("ROSTER_SCHEMA");
    const e = parsed.data;
    if (this.state && e.seq <= this.state.head.seq) {
      if (this.state.hashes[e.seq] === rosterEntryHash(e)) return "known";
      this.forked = true;
      throw new RosterError("ROSTER_FORK");
    }
    this.state = applyRosterEntry(this.state, e);
    this.entries.push(e);
    return "appended";
  }

  /** Aynı sıra numarasındaki özetin bizimkiyle aynı olup olmadığı (rh doğrulaması). */
  hashAt(seq: number): string | undefined {
    return this.state?.hashes[seq];
  }
}

// ---- Telefon tarafı (ve testler): giriş oluşturma ----------------------------------------------

export interface EntryDraft {
  ws: string;
  seq: number;
  prev: string;
  ts: number;
  op: RosterOp;
  body: unknown;
  signer: string;
}

/** Sahibin onay anahtarıyla imzalar. Android'de bu işlem biyometrik doğrulama gerektirir. */
export function signRosterEntry(d: EntryDraft, ownerApprovalSecret: Uint8Array): RosterEntry {
  const base = { v: 1 as const, ...d };
  return { ...base, sig: toB64(sign("SAKLAZ-v1/roster", signingBytes(base), ownerApprovalSecret)) };
}

/** Eklenen cihaz, kendi imza anahtarıyla eş-imza atar (anahtar sahipliği kanıtı). */
export function cosignRosterEntry(e: RosterEntry, newDeviceSignSecret: Uint8Array): RosterEntry {
  // Mevcut eş-imza (varsa) atılır; yeni eş-imza aynı imzalanan baytlar üzerinden atılır.
  const base = { v: e.v, ws: e.ws, seq: e.seq, prev: e.prev, ts: e.ts, op: e.op, body: e.body, signer: e.signer };
  const sig = e.sig;
  return { ...base, sig, cosig: toB64(sign("SAKLAZ-v1/roster", signingBytes(base), newDeviceSignSecret)) };
}

export { ZERO_HASH as ROSTER_GENESIS_PREV };
