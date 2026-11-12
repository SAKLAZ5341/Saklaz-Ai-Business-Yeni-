import { beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalLedger,
  computeApprovalDigest,
  MemoryApprovalStore,
  ProtocolError,
  signApprovalDecision,
  verifyApprovalRequestDigest,
  type ApprovalAction,
} from "../src/index.js";
import { AGENT_ID, makePhone, NOW, OTHER_WS, PHONE_ID, setup, TASK, WS } from "./helpers.js";

beforeAll(setup);

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};

const deleteAction = (): ApprovalAction => ({
  toolKey: "fs.moveToRecycleBin",
  risk: "critical",
  summary: "3 dosya Geri Dönüşüm Kutusu'na taşınacak",
  targets: [
    { kind: "file", value: "C:\\Belgeler\\SAKLAZ-TEST\\a.xlsx" },
    { kind: "file", value: "C:\\Belgeler\\SAKLAZ-TEST\\b.xlsx" },
    { kind: "file", value: "C:\\Belgeler\\SAKLAZ-TEST\\c.xlsx" },
  ],
  params: { paths: ["C:\\Belgeler\\SAKLAZ-TEST\\a.xlsx", "C:\\Belgeler\\SAKLAZ-TEST\\b.xlsx", "C:\\Belgeler\\SAKLAZ-TEST\\c.xlsx"] },
});

let n = 0;
const approvalId = () => `01934b6e-0000-7000-8000-${String(++n).padStart(12, "0")}`;

function flow(action = deleteAction()) {
  const phone = makePhone();
  const ledger = new ApprovalLedger(new MemoryApprovalStore(), WS, AGENT_ID);
  const id = approvalId();
  const req = ledger.createRequest({ approvalId: id, phoneId: PHONE_ID, taskId: TASK, stepId: "s1", action, nowMs: NOW });
  return { phone, ledger, req, id, action };
}

describe("işleme bağlı onay", () => {
  it("tam akış: istek → telefon kendi özetini doğrular → imzalar → ajan doğrular → aynı parametrelerle çalışır", () => {
    const { phone, ledger, req, action } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    const rec = ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 30_000);
    expect(rec.state).toBe("approved");
    expect(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s1", action })).not.toThrow();
  });

  it("onaydan SONRA parametre değiştirilirse çalıştırma reddedilir (hedef dosya eklenmiş)", () => {
    const { phone, ledger, req, action } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 1000);
    const changed: ApprovalAction = {
      ...action,
      params: { paths: [...(action.params["paths"] as string[]), "C:\\Belgeler\\onemli.xlsx"] },
    };
    expect(code(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s1", action: changed }))).toBe(
      "EXECUTION_PARAMS_CHANGED",
    );
    expect(code(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s2", action }))).toBe(
      "EXECUTION_PARAMS_CHANGED",
    );
    expect(code(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s1", action: { ...action, toolKey: "fs.overwrite" } }))).toBe(
      "EXECUTION_PARAMS_CHANGED",
    );
  });

  it("ekranda gösterilen içerik özetle uyuşmuyorsa telefon onay ekranını hiç göstermez", () => {
    const { req } = flow();
    // Özet değişmeden hedef listesi kurcalanırsa (ör. relay veya hatalı ajan)
    const tampered = { ...req, action: { ...req.action, targets: req.action.targets.slice(0, 1) } };
    expect(code(() => verifyApprovalRequestDigest(WS, AGENT_ID, PHONE_ID, tampered))).toBe("APPROVAL_MISMATCH");
    const sneaky = { ...req, action: { ...req.action, summary: "Rapor oluşturulacak" } };
    expect(code(() => verifyApprovalRequestDigest(WS, AGENT_ID, PHONE_ID, sneaky))).toBe("APPROVAL_MISMATCH");
    expect(code(() => verifyApprovalRequestDigest(WS, AGENT_ID, "dev_baskaTelefonCCCCCCCCC", req))).toBe("APPROVAL_MISMATCH");
  });

  it("onay tek kullanımlıktır: ikinci kullanım reddedilir", () => {
    const { phone, ledger, req } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 1000);
    expect(code(() => ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 2000))).toBe("APPROVAL_USED");
  });

  it("süresi dolan onay geçersizdir ve sonra tekrar denenemez; süre ajanın saatiyle ölçülür", () => {
    const { phone, ledger, req } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    expect(code(() => ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 600_001))).toBe("APPROVAL_EXPIRED");
    expect(code(() => ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 1000))).toBe("APPROVAL_USED");
    expect(code(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s1", action: req.action }))).toBe(
      "APPROVAL_NOT_GRANTED",
    );
    // Ajan saati geri alınmışsa (verilme zamanından önce) da reddedilir
    const f = flow();
    const d2 = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: f.req, decision: "approve", approvalSecretKey: f.phone.approval.secretKey });
    expect(code(() => f.ledger.consumeDecision(PHONE_ID, d2, f.phone.approval.publicKey, NOW - 1))).toBe("APPROVAL_EXPIRED");
  });

  it("onay, komut anahtarıyla değil yalnızca ayrı onay anahtarıyla geçerlidir", () => {
    const { phone, ledger, req } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.sign.secretKey });
    expect(code(() => ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 1000))).toBe("APPROVAL_WRONG_SIGNER");
  });

  it("başka telefonun kararı, kurcalanmış karar ve yanlış challenge reddedilir", () => {
    const { phone, ledger, req } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    expect(code(() => ledger.consumeDecision("dev_baskaTelefonCCCCCCCCC", dec, phone.approval.publicKey, NOW + 1000))).toBe(
      "APPROVAL_WRONG_SIGNER",
    );
    // Ret imzası onay olarak gösterilemez
    const rejectSig = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "reject", approvalSecretKey: phone.approval.secretKey });
    expect(code(() => ledger.consumeDecision(PHONE_ID, { ...rejectSig, decision: "approve" }, phone.approval.publicKey, NOW + 1000))).toBe(
      "APPROVAL_WRONG_SIGNER",
    );
    expect(code(() => ledger.consumeDecision(PHONE_ID, { ...dec, challenge: req.digest }, phone.approval.publicKey, NOW + 1000))).toBe(
      "APPROVAL_MISMATCH",
    );
    expect(code(() => ledger.consumeDecision(PHONE_ID, { ...dec, digest: req.challenge }, phone.approval.publicKey, NOW + 1000))).toBe(
      "APPROVAL_MISMATCH",
    );
  });

  it("ret kararı kaydı tüketir ve çalıştırmaya izin vermez", () => {
    const { phone, ledger, req } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "reject", approvalSecretKey: phone.approval.secretKey });
    expect(ledger.consumeDecision(PHONE_ID, dec, phone.approval.publicKey, NOW + 1000).state).toBe("rejected");
    expect(code(() => ledger.assertExecutionMatches(req.approvalId, { taskId: TASK, stepId: "s1", action: req.action }))).toBe(
      "APPROVAL_NOT_GRANTED",
    );
  });

  it("bilinmeyen onay kimliği ve tekrar kullanılan kimlik reddedilir", () => {
    const { phone, ledger, req, id } = flow();
    const dec = signApprovalDecision({ workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: req, decision: "approve", approvalSecretKey: phone.approval.secretKey });
    expect(code(() => ledger.consumeDecision(PHONE_ID, { ...dec, approvalId: approvalId() }, phone.approval.publicKey, NOW))).toBe(
      "APPROVAL_UNKNOWN",
    );
    expect(code(() => ledger.assertExecutionMatches(approvalId(), { taskId: TASK, stepId: "s1", action: req.action }))).toBe(
      "APPROVAL_UNKNOWN",
    );
    expect(code(() => ledger.createRequest({ approvalId: id, phoneId: PHONE_ID, taskId: TASK, stepId: "s1", action: req.action, nowMs: NOW }))).toBe(
      "SCHEMA_INVALID",
    );
  });

  it("çalışma alanı izolasyonu: BUSINESS alanında hesaplanan özet PERSONAL alanındaki isteği karşılamaz", () => {
    const { req } = flow();
    expect(code(() => verifyApprovalRequestDigest(OTHER_WS, AGENT_ID, PHONE_ID, req))).toBe("APPROVAL_MISMATCH");
    const { phone, req: r2 } = flow();
    // Telefon, isteği yanlışlıkla diğer alanın bağlamıyla imzalamaya çalışırsa kendi doğrulaması reddeder
    expect(code(() => signApprovalDecision({ workspaceId: OTHER_WS, agentId: AGENT_ID, phoneId: PHONE_ID, request: r2, decision: "approve", approvalSecretKey: phone.approval.secretKey }))).toBe(
      "APPROVAL_MISMATCH",
    );
  });

  it("her challenge benzersizdir; aynı işlem için iki istek farklı özet üretir", () => {
    const a = flow();
    const b = flow();
    expect(a.req.challenge).not.toBe(b.req.challenge);
    expect(a.req.digest).not.toBe(b.req.digest);
  });

  it("özet, parametre nesnesinin anahtar sırasından bağımsızdır (kanonik JSON)", () => {
    const base = { workspaceId: WS, agentId: AGENT_ID, phoneId: PHONE_ID, approvalId: approvalId(), taskId: TASK, stepId: "s1", challenge: "x", issuedAt: NOW, expiresInSec: 600 };
    const a1 = { ...deleteAction(), params: { a: 1, b: 2 } };
    const a2 = { ...deleteAction(), params: { b: 2, a: 1 } };
    expect(computeApprovalDigest({ ...base, action: a1 })).toEqual(computeApprovalDigest({ ...base, action: a2 }));
  });
});
