/**
 * Protokol şemaları (saklaz/1). Tüm nesneler katıdır: bilinmeyen alan içeren mesaj reddedilir.
 * Zaman alanları Unix epoch milisaniye tam sayılarıdır (diller arası tarih ayrıştırma farkı yok).
 * İkili alanlar base64url (dolgusuz) metindir.
 */
import { z } from "zod";
import { canonicalize, type JsonValue } from "./jcs.js";

export const PROTOCOL_VERSION = "saklaz/1";

// ---- Temel alan biçimleri -------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Sabit uzunluklu, KANONİK base64url. Son karakterin kullanılmayan (dolgu) bitleri sıfır olmalıdır;
 * aksi halde aynı baytlar birden fazla metinle gösterilebilir ve alt katman (libsodium) bunu
 * reddeder. Bu kontrolü şema düzeyinde yapmak, her ret durumunun tipli bir ProtocolError
 * (SCHEMA_INVALID) olmasını sağlar. (Sprint 1'de özellik tabanlı testle bulundu.)
 */
const b64urlOfBytes = (bytes: number) => {
  const len = Math.ceil((bytes * 4) / 3);
  const padBits = len * 6 - bytes * 8;
  return z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${len}}$`), `base64url (${bytes} bayt) bekleniyor`)
    .refine((s) => B64_ALPHABET.indexOf(s.charAt(len - 1)) % (1 << padBits) === 0, "kanonik olmayan base64url");
};

export const B64_16 = b64urlOfBytes(16);
export const B64_32 = b64urlOfBytes(32);
export const B64_64 = b64urlOfBytes(64);

export const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "küçük harfli UUID bekleniyor");

export const DeviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{16,64}$/, "cihaz kimliği biçimi geçersiz");

export const EpochMs = z.number().int().min(1_600_000_000_000).max(Number.MAX_SAFE_INTEGER);

const SafeText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => s.isWellFormed(), "iyi biçimli Unicode değil")
    // Kontrol karakterleri (satır sonu ve sekme hariç) onay ekranını yanıltmak için kullanılabilir.
    // eslint-disable-next-line no-control-regex -- kontrol karakterlerini REDDETMEK için bilinçli
    .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u.test(s), {
      message: "izin verilmeyen kontrol veya yön karakteri",
    });

/** Kanonik JSON'a çevrilebilen değer (tam sayı, metin, boolean, null, dizi, nesne). */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    SafeText(10_000),
    z.array(JsonValueSchema).max(1_000),
    z.record(z.string().max(128), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z
  .record(z.string().max(128), JsonValueSchema)
  .refine((o) => {
    try {
      return canonicalize(o).length <= 64 * 1024;
    } catch {
      return false;
    }
  }, "parametreler kanonik JSON'a çevrilemiyor veya çok büyük");

// ---- Mesaj tipleri ---------------------------------------------------------------------------

export const PHONE_TO_AGENT_TYPES = [
  "cmd.create",
  "cmd.cancel",
  "approval.decision",
  "history.query",
  "file.request",
  "device.revoke",
  "grant.request",
  "agent.lockdown",
  "ack",
] as const;

export const AGENT_TO_PHONE_TYPES = [
  "task.event",
  "approval.request",
  "history.page",
  "file.offer",
  "ack",
] as const;

export const MESSAGE_TYPES = [...new Set([...PHONE_TO_AGENT_TYPES, ...AGENT_TO_PHONE_TYPES])] as const;
export type MessageType = (typeof PHONE_TO_AGENT_TYPES)[number] | (typeof AGENT_TO_PHONE_TYPES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Her mesaj tipinin imzalı ömrünün (exp - ts) üst sınırı. Kuyruğa alınabilecek mesajlar
 * (çevrimdışı bilgisayara giden komut, acil kilit, cihaz iptali) daha uzun yaşayabilir;
 * etkileşimli mesajlar kısa ömürlüdür. Relay bu değerleri değiştiremez (imzalıdır).
 */
export const MAX_LIFETIME_MS: Record<MessageType, number> = {
  "cmd.create": 72 * HOUR,
  "cmd.cancel": 72 * HOUR,
  "device.revoke": 72 * HOUR,
  "agent.lockdown": 72 * HOUR,
  "approval.decision": 10 * MINUTE,
  "history.query": 10 * MINUTE,
  "file.request": 10 * MINUTE,
  "grant.request": 10 * MINUTE,
  ack: 72 * HOUR,
  "task.event": 72 * HOUR,
  "approval.request": 10 * MINUTE,
  "history.page": 10 * MINUTE,
  "file.offer": 24 * HOUR,
};

// ---- Başlık -----------------------------------------------------------------------------------

export const HeaderSchema = z.strictObject({
  proto: z.literal(PROTOCOL_VERSION),
  type: z.enum(MESSAGE_TYPES as unknown as [MessageType, ...MessageType[]]),
  msgId: Uuid,
  from: DeviceId,
  to: DeviceId,
  /** Gönderen→alıcı yönünde monoton artan sayaç (tekrar oynatma koruması). */
  ctr: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ts: EpochMs,
  /** İmzalı son geçerlilik zamanı. */
  exp: EpochMs,
  nonce: B64_16,
});
export type Header = z.infer<typeof HeaderSchema>;

// ---- Gövdeler ----------------------------------------------------------------------------------

const TaskId = Uuid;
const StepId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ToolKey = z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, "araç anahtarı biçimi geçersiz");
const AgentKey = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

export const TARGET_KINDS = ["file", "folder", "program", "recipient", "erp-record", "url", "device", "other"] as const;

export const ApprovalTargetSchema = z.strictObject({
  kind: z.enum(TARGET_KINDS),
  value: SafeText(1024, 1),
});

export const ApprovalActionSchema = z.strictObject({
  toolKey: ToolKey,
  risk: z.enum(["write", "critical"]),
  /** İnsan tarafından okunabilir özet. Telefon bunun YANINDA hedefleri ve parametreleri de gösterir. */
  summary: SafeText(500, 1),
  targets: z.array(ApprovalTargetSchema).max(200),
  params: JsonObjectSchema,
});
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const BodySchemas = {
  "cmd.create": z.strictObject({
    taskId: TaskId,
    text: SafeText(4000, 1),
    agent: AgentKey.optional(),
    options: z.record(z.string().max(64), z.union([SafeText(256), z.number().int(), z.boolean()])).optional(),
  }),
  "cmd.cancel": z.strictObject({
    taskId: TaskId,
    reason: SafeText(500).optional(),
  }),
  "approval.decision": z.strictObject({
    approvalId: Uuid,
    decision: z.enum(["approve", "reject"]),
    digest: B64_32,
    challenge: B64_32,
    /** Onay alanında (SAKLAZ-v1/approval), telefonun onay anahtarıyla atılan imza. */
    approvalSig: B64_64,
  }),
  "history.query": z.strictObject({
    sinceSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(500),
  }),
  "file.request": z.strictObject({
    fileRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  }),
  "device.revoke": z.strictObject({
    deviceId: DeviceId,
    reason: SafeText(500).optional(),
  }),
  "grant.request": z.strictObject({
    path: SafeText(1024, 3),
    access: z.enum(["read", "read_write"]),
    recursive: z.boolean(),
  }),
  "agent.lockdown": z.strictObject({
    reason: SafeText(500).optional(),
  }),
  ack: z.strictObject({
    ackOf: Uuid,
    status: z.enum(["accepted", "duplicate", "rejected"]),
    /** Yalnızca genel kod; ayrıntı ajan denetim kaydındadır. */
    code: z.enum(["OK", "DUPLICATE", "REJECTED"]),
  }),
  "task.event": z.strictObject({
    taskId: TaskId,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: z.enum([
      "received",
      "running",
      "awaiting_approval",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
      "interrupted",
      "approval_expired",
      "rejected",
    ]),
    progress: z.number().int().min(0).max(100).optional(),
    summary: SafeText(4000).optional(),
    error: z.strictObject({ code: z.string().regex(/^[A-Z_]{2,64}$/), message: SafeText(500) }).optional(),
  }),
  "approval.request": z.strictObject({
    approvalId: Uuid,
    taskId: TaskId,
    stepId: StepId,
    action: ApprovalActionSchema,
    challenge: B64_32,
    /** Ajan saatine göre verilme zamanı; süre ajan saatiyle ölçülür (FAZ1-PLAN §8.3). */
    issuedAt: EpochMs,
    expiresInSec: z.number().int().min(30).max(600),
    digest: B64_32,
  }),
  "history.page": z.strictObject({
    items: z
      .array(
        z.strictObject({
          taskId: TaskId,
          title: SafeText(200),
          status: z.string().regex(/^[a-z_]{2,32}$/),
          createdAt: EpochMs,
          finishedAt: EpochMs.optional(),
        }),
      )
      .max(500),
    nextSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  "file.offer": z.strictObject({
    fileId: Uuid,
    name: SafeText(255, 1),
    size: z.number().int().min(0).max(2 * 1024 * 1024 * 1024),
    sha256: B64_32,
    fileKey: B64_32,
    chunkCount: z.number().int().min(1).max(40_000),
  }),
} as const satisfies Record<MessageType, z.ZodType>;

export type Body<T extends MessageType> = z.infer<(typeof BodySchemas)[T]>;

export interface InnerMessage<T extends MessageType = MessageType> {
  hdr: Header & { type: T };
  body: Body<T>;
  /** Ed25519 imzası (SAKLAZ-v1/msg), base64url. */
  sig: string;
}

export const RawInnerMessageSchema = z.strictObject({
  hdr: z.unknown(),
  body: z.unknown(),
  sig: B64_64,
});
