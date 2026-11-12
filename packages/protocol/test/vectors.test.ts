import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dhKeyPairFromSecret,
  fromB64,
  fromHex,
  initCrypto,
  open,
  toHex,
  verify,
} from "@saklaz/crypto";
import {
  RosterLog,
  approvalSigningBytes,
  canonicalize,
  computeApprovalDigest,
  parseInnerMessage,
  verifyInnerMessageSignature,
} from "../src/index.js";
import { generateVectors, VECTORS_PATH } from "../scripts/generate-vectors.js";

interface Vectors {
  roster: { entries: unknown[]; hashes: string[] };
  jcs: { input: unknown; canonical: string }[];
  signatures: { domain: "SAKLAZ-v1/msg"; publicKeyHex: string; messageHex: string; signatureHex: string }[];
  sealed: Record<string, string>;
  message: { hdr: unknown; body: unknown; sig: string; signerPublicHex: string };
  approval: {
    context: Parameters<typeof computeApprovalDigest>[0];
    digest: string;
    approvalSignerPublicHex: string;
    approvalSig: string;
    signingBytesHex: string;
  };
}

const committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

beforeAll(initCrypto);

describe("çapraz platform test vektörleri", () => {
  it("depodaki vektör dosyası, kodun bugünkü çıktısıyla birebir aynı (sapma yok)", async () => {
    expect(JSON.parse(JSON.stringify(await generateVectors()))).toEqual(committed);
  });

  it("JCS vektörleri", () => {
    for (const c of committed.jcs) expect(canonicalize(c.input)).toBe(c.canonical);
  });

  it("imza vektörleri bağımsız olarak doğrulanır", () => {
    for (const s of committed.signatures) {
      expect(verify(s.domain, fromHex(s.messageHex), fromHex(s.signatureHex), fromHex(s.publicKeyHex))).toBe(true);
    }
  });

  it("mühürlü zarf vektörü alıcı tarafında açılır", () => {
    const v = committed.sealed;
    const recipient = dhKeyPairFromSecret(fromHex("12".repeat(32)));
    expect(toHex(recipient.publicKey)).toBe(v["recipientPublicHex"]);
    const sender = dhKeyPairFromSecret(fromHex(v["senderSecretHex"] ?? ""));
    const pt = open(
      recipient,
      sender.publicKey,
      {
        ephemeralPublicKey: fromHex(v["ephemeralPublicHex"] ?? ""),
        nonce: fromHex(v["nonceHex"] ?? ""),
        ciphertext: fromHex(v["ciphertextHex"] ?? ""),
      },
      fromHex(v["contextHex"] ?? ""),
    );
    expect(toHex(pt)).toBe(v["plaintextHex"]);
  });

  it("imzalı mesaj vektörü ayrıştırılır ve doğrulanır", () => {
    const m = parseInnerMessage({ hdr: committed.message.hdr, body: committed.message.body, sig: committed.message.sig });
    expect(() => verifyInnerMessageSignature(m, fromHex(committed.message.signerPublicHex))).not.toThrow();
  });

  it("onay vektörü: özet ve onay imzası doğrulanır", () => {
    const a = committed.approval;
    expect(Buffer.from(computeApprovalDigest(a.context)).toString("base64url")).toBe(a.digest);
    const bytes = approvalSigningBytes({
      workspaceId: a.context.workspaceId,
      agentId: a.context.agentId,
      phoneId: a.context.phoneId,
      approvalId: a.context.approvalId,
      digest: a.digest,
      decision: "approve",
      challenge: a.context.challenge,
    });
    expect(toHex(bytes)).toBe(a.signingBytesHex);
    expect(verify("SAKLAZ-v1/approval", bytes, fromB64(a.approvalSig), fromHex(a.approvalSignerPublicHex))).toBe(true);
  });

  it("cihaz listesi vektörü: zincir doğrulanır, özetler birebir aynı", () => {
    const log = RosterLog.fromEntries(committed.roster.entries);
    expect(log.head().seq).toBe(2);
    committed.roster.hashes.forEach((h, i) => {
      expect(log.hashAt(i)).toBe(h);
    });
  });
});
