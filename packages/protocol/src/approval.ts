/**
 * İşleme bağlı onaylar — proje sahibinin ek güvenlik isteği (2026-11-12) ve SECURITY.md §7.
 *
 * Bir onay "genel bir evet" değildir. Telefonun imzaladığı özet (digest) şunların TAMAMINI kapsar:
 *   çalışma alanı, ajan, telefon, onay kimliği, görev, adım, araç, risk, özet metni, hedefler (dosya/program/alıcı),
 *   parametrelerin tamamı, ajanın rastgele challenge değeri, verilme zamanı ve süresi.
 *
 * Sonuç:
 *   • Parametrelerden tek bir bayt değişirse özet değişir → onay geçersiz (APPROVAL_MISMATCH).
 *   • Ajan, adımı ÇALIŞTIRMADAN hemen önce özeti çalıştıracağı gerçek parametrelerden yeniden
 *     hesaplar → onaydan sonra değiştirilmiş işlem çalışamaz (EXECUTION_PARAMS_CHANGED).
 *   • Onay tek kullanımlıktır (onay veya ret fark etmez, kayıt tüketilir) → APPROVAL_USED.
 *   • Süre AJANIN saatiyle, isteğin verildiği andan itibaren ölçülür → APPROVAL_EXPIRED.
 *   • İmza, telefonun ayrı ONAY anahtarıyla (her kullanımda biyometrik) atılır → APPROVAL_WRONG_SIGNER.
 */
import { equalConstantTime, fromB64, randomBytes, sign, taggedHash, toB64, verify } from "@saklaz/crypto";
import { canonicalBytes } from "./jcs.js";
import { ProtocolError } from "./errors.js";
import { ApprovalActionSchema, type ApprovalAction, type Body } from "./schemas.js";

export interface ApprovalContext {
  /** Çalışma alanı (ADR-0013): başka alandaki bir onay bu alanda geçersizdir. */
  workspaceId: string;
  agentId: string;
  phoneId: string;
  approvalId: string;
  taskId: string;
  stepId: string;
  action: ApprovalAction;
  challenge: string;
  issuedAt: number;
  expiresInSec: number;
}

/** Onay özeti: tüm işlem bağlamının alan ayrımlı BLAKE2b-256 özeti. */
export function computeApprovalDigest(c: ApprovalContext): Uint8Array {
  const action = ApprovalActionSchema.parse(c.action);
  return taggedHash(
    "SAKLAZ-v1/approval-digest",
    canonicalBytes({
      v: 1,
      ws: c.workspaceId,
      agentId: c.agentId,
      phoneId: c.phoneId,
      approvalId: c.approvalId,
      taskId: c.taskId,
      stepId: c.stepId,
      action,
      challenge: c.challenge,
      issuedAt: c.issuedAt,
      expiresInSec: c.expiresInSec,
    }),
    32,
  );
}

/** Telefonun onay anahtarıyla imzalanan bayt dizisi. */
export function approvalSigningBytes(i: {
  workspaceId: string;
  agentId: string;
  phoneId: string;
  approvalId: string;
  digest: string;
  decision: "approve" | "reject";
  challenge: string;
}): Uint8Array {
  return canonicalBytes({
    v: 1,
    ws: i.workspaceId,
    agentId: i.agentId,
    phoneId: i.phoneId,
    approvalId: i.approvalId,
    digest: i.digest,
    decision: i.decision,
    challenge: i.challenge,
  });
}

// ---- Ajan tarafı ------------------------------------------------------------------------------

export interface PendingApproval {
  workspaceId: string;
  approvalId: string;
  agentId: string;
  phoneId: string;
  taskId: string;
  stepId: string;
  action: ApprovalAction;
  challenge: string;
  issuedAt: number;
  expiresInSec: number;
  digest: string;
  /** "pending" → tek bir karar sonrası "approved" | "rejected" | "expired" olur ve bir daha değişmez. */
  state: "pending" | "approved" | "rejected" | "expired";
}

export interface ApprovalStore {
  get(approvalId: string): PendingApproval | undefined;
  put(record: PendingApproval): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly m = new Map<string, PendingApproval>();
  get(id: string): PendingApproval | undefined {
    const r = this.m.get(id);
    return r ? structuredClone(r) : undefined;
  }
  put(r: PendingApproval): void {
    this.m.set(r.approvalId, structuredClone(r));
  }
}

export const DEFAULT_APPROVAL_TTL_SEC = 600;

export class ApprovalLedger {
  constructor(
    private readonly store: ApprovalStore,
    private readonly workspaceId: string,
    private readonly agentId: string,
  ) {}

  /** Ajan bir adım için onay ister. Dönen gövde telefona imzalı mesajla gönderilir. */
  createRequest(i: {
    approvalId: string;
    phoneId: string;
    taskId: string;
    stepId: string;
    action: ApprovalAction;
    nowMs: number;
    expiresInSec?: number;
  }): Body<"approval.request"> {
    if (this.store.get(i.approvalId)) throw new ProtocolError("SCHEMA_INVALID", "Onay kimliği zaten kullanıldı.");
    const expiresInSec = i.expiresInSec ?? DEFAULT_APPROVAL_TTL_SEC;
    const challenge = toB64(randomBytes(32));
    const ctx: ApprovalContext = {
      workspaceId: this.workspaceId,
      agentId: this.agentId,
      phoneId: i.phoneId,
      approvalId: i.approvalId,
      taskId: i.taskId,
      stepId: i.stepId,
      action: i.action,
      challenge,
      issuedAt: i.nowMs,
      expiresInSec,
    };
    const digest = toB64(computeApprovalDigest(ctx));
    this.store.put({ ...ctx, action: ApprovalActionSchema.parse(i.action), digest, state: "pending" });
    return {
      approvalId: i.approvalId,
      taskId: i.taskId,
      stepId: i.stepId,
      action: i.action,
      challenge,
      issuedAt: i.nowMs,
      expiresInSec,
      digest,
    };
  }

  /**
   * Telefondan gelen kararı doğrular ve kaydı TÜKETİR.
   * Not: Bu çağrıdan önce mesaj zarfının imzası, sayaç ve rol denetimi (IncomingVerifier) yapılmış olmalıdır.
   * @param phoneApprovalPub Eşleştirmede sabitlenmiş, telefonun ONAY imza anahtarı.
   * @returns Karar onaysa kayıt (çalıştırma öncesi assertExecutionMatches ile birlikte kullanılır).
   */
  consumeDecision(
    fromPhoneId: string,
    decision: Body<"approval.decision">,
    phoneApprovalPub: Uint8Array,
    nowMs: number,
  ): PendingApproval {
    const rec = this.store.get(decision.approvalId);
    if (!rec) throw new ProtocolError("APPROVAL_UNKNOWN");
    if (rec.state !== "pending") throw new ProtocolError("APPROVAL_USED");
    if (rec.phoneId !== fromPhoneId) throw new ProtocolError("APPROVAL_WRONG_SIGNER");
    if (nowMs > rec.issuedAt + rec.expiresInSec * 1000 || nowMs < rec.issuedAt) {
      this.store.put({ ...rec, state: "expired" });
      throw new ProtocolError("APPROVAL_EXPIRED");
    }
    const sameDigest = equalConstantTime(fromB64(decision.digest), fromB64(rec.digest));
    const sameChallenge = equalConstantTime(fromB64(decision.challenge), fromB64(rec.challenge));
    if (!sameDigest || !sameChallenge) throw new ProtocolError("APPROVAL_MISMATCH");
    const ok = verify(
      "SAKLAZ-v1/approval",
      approvalSigningBytes({
        workspaceId: rec.workspaceId,
        agentId: rec.agentId,
        phoneId: rec.phoneId,
        approvalId: rec.approvalId,
        digest: rec.digest,
        decision: decision.decision,
        challenge: rec.challenge,
      }),
      fromB64(decision.approvalSig),
      phoneApprovalPub,
    );
    if (!ok) throw new ProtocolError("APPROVAL_WRONG_SIGNER");
    const state = decision.decision === "approve" ? "approved" : "rejected";
    const done: PendingApproval = { ...rec, state };
    this.store.put(done);
    return done;
  }

  /**
   * Araç çalıştırılmadan HEMEN önce çağrılır. Çalıştırılacak gerçek parametrelerden özeti yeniden
   * hesaplar; onaylanan özetle birebir aynı değilse çalıştırma reddedilir.
   */
  assertExecutionMatches(approvalId: string, actual: { taskId: string; stepId: string; action: ApprovalAction }): void {
    const rec = this.store.get(approvalId);
    if (!rec) throw new ProtocolError("APPROVAL_UNKNOWN");
    if (rec.state !== "approved") throw new ProtocolError("APPROVAL_NOT_GRANTED");
    const recomputed = computeApprovalDigest({
      workspaceId: rec.workspaceId,
      agentId: rec.agentId,
      phoneId: rec.phoneId,
      approvalId: rec.approvalId,
      taskId: actual.taskId,
      stepId: actual.stepId,
      action: actual.action,
      challenge: rec.challenge,
      issuedAt: rec.issuedAt,
      expiresInSec: rec.expiresInSec,
    });
    if (!equalConstantTime(recomputed, fromB64(rec.digest))) throw new ProtocolError("EXECUTION_PARAMS_CHANGED");
  }
}

// ---- Telefon tarafı ---------------------------------------------------------------------------

/**
 * Telefon, onay ekranını göstermeden ÖNCE özeti kendisi yeniden hesaplar. Ajanın gönderdiği özet
 * gösterilen içerikle uyuşmuyorsa onay ekranı hiç gösterilmez.
 */
export function verifyApprovalRequestDigest(
  workspaceId: string,
  agentId: string,
  phoneId: string,
  req: Body<"approval.request">,
): void {
  const d = computeApprovalDigest({ workspaceId, agentId, phoneId, ...req });
  if (!equalConstantTime(d, fromB64(req.digest))) throw new ProtocolError("APPROVAL_MISMATCH");
}

/** Telefon kararı imzalar (Android'de bu imza biyometrik doğrulamaya bağlı onay anahtarıyla atılır). */
export function signApprovalDecision(i: {
  workspaceId: string;
  agentId: string;
  phoneId: string;
  request: Body<"approval.request">;
  decision: "approve" | "reject";
  approvalSecretKey: Uint8Array;
}): Body<"approval.decision"> {
  verifyApprovalRequestDigest(i.workspaceId, i.agentId, i.phoneId, i.request);
  const sig = sign(
    "SAKLAZ-v1/approval",
    approvalSigningBytes({
      workspaceId: i.workspaceId,
      agentId: i.agentId,
      phoneId: i.phoneId,
      approvalId: i.request.approvalId,
      digest: i.request.digest,
      decision: i.decision,
      challenge: i.request.challenge,
    }),
    i.approvalSecretKey,
  );
  return {
    approvalId: i.request.approvalId,
    decision: i.decision,
    digest: i.request.digest,
    challenge: i.request.challenge,
    approvalSig: toB64(sig),
  };
}
