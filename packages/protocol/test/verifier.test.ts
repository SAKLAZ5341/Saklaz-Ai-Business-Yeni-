import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { generateSigningKeyPair } from "@saklaz/crypto";
import {
  IncomingVerifier,
  checkTiming,
  MemoryReplayStore,
  ProtocolError,
  REPLAY_WINDOW,
  ReplayGuard,
  CLOCK_SKEW_MS,
} from "../src/index.js";
import { bytesOf, makePhone, makeVerifier, makeWorld, NOW, send, setup, TASK, fakeB64 } from "./helpers.js";

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

describe("tekrar oynatma koruması", () => {
  it("aynı sayaç ikinci kez işlenmez; pencere altındaki eski sayaç reddedilir", () => {
    const g = new ReplayGuard(new MemoryReplayStore());
    expect(g.checkAndRecord("p", 5)).toBe("fresh");
    expect(g.checkAndRecord("p", 5)).toBe("duplicate");
    expect(g.checkAndRecord("p", 3)).toBe("fresh"); // kuyruktan geç gelen eski ama görülmemiş mesaj
    expect(g.checkAndRecord("p", 3)).toBe("duplicate");
    expect(g.checkAndRecord("p", 5 + REPLAY_WINDOW)).toBe("fresh");
    expect(code(() => g.checkAndRecord("p", 3))).toBe("REPLAY_COUNTER");
    expect(code(() => g.checkAndRecord("p", 5))).toBe("REPLAY_COUNTER");
    expect(g.checkAndRecord("baska", 1)).toBe("fresh"); // durum gönderen başına tutulur
  });

  it("özellik: hiçbir sayaç dizisinde aynı sayaç iki kez 'fresh' olmaz", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5000 }), { maxLength: 300 }), (ctrs) => {
        const g = new ReplayGuard(new MemoryReplayStore());
        const fresh = new Set<number>();
        for (const c of ctrs) {
          try {
            if (g.checkAndRecord("p", c) === "fresh") {
              if (fresh.has(c)) return false;
              fresh.add(c);
            }
          } catch {
            /* pencere altı: reddedildi */
          }
        }
        return true;
      }),
    );
  });

  it("zaman: gelecekten gelen ve süresi dolmuş mesajlar reddedilir", () => {
    expect(code(() => checkTiming({ ts: NOW + CLOCK_SKEW_MS + 1, exp: NOW + 10 * CLOCK_SKEW_MS }, NOW))).toBe("TS_IN_FUTURE");
    expect(code(() => checkTiming({ ts: NOW - 10_000, exp: NOW - 1 }, NOW))).toBe("MESSAGE_EXPIRED");
    expect(code(() => checkTiming({ ts: NOW, exp: NOW + 1 }, NOW))).toBe("NO_ERROR");
  });
});

describe("gelen mesaj doğrulama hattı", () => {
  it("geçerli komut kabul edilir; aynı mesaj tekrar gelirse 'duplicate' olur ve yeniden işlenmez", () => {
    const p = makePhone();
    const v = makeVerifier([p]);
    const b = bytesOf(send(p, "cmd.create", { taskId: TASK, text: "Excel özetle" }));
    expect(v.verify(b, NOW).verdict).toBe("fresh");
    expect(v.verify(b, NOW).verdict).toBe("duplicate");
  });

  it("eşleştirilmemiş, iptal edilmiş gönderen ve yanlış alıcı reddedilir", () => {
    const p = makePhone();
    const stranger = makePhone("dev_yabanciDDDDDDDDDDDDDD");
    expect(code(() => makeVerifier([p]).verify(bytesOf(send(stranger, "cmd.create", { taskId: TASK, text: "x" })), NOW))).toBe(
      "UNKNOWN_SENDER",
    );
    expect(code(() => makeVerifier([p], undefined, [p.id]).verify(bytesOf(send(p, "cmd.create", { taskId: TASK, text: "x" })), NOW))).toBe(
      "UNKNOWN_SENDER",
    );
    expect(
      code(() => makeVerifier([p]).verify(bytesOf(send(p, "cmd.create", { taskId: TASK, text: "x" }, { to: "dev_baskaAjanEEEEEEEEEEEE" })), NOW)),
    ).toBe("WRONG_RECIPIENT");
  });

  it("telefon, ajana ait mesaj tiplerini gönderemez (ör. sahte onay isteği)", () => {
    const p = makePhone();
    const m = send(p, "task.event", { taskId: TASK, seq: 1, status: "succeeded" });
    expect(code(() => makeVerifier([p]).verify(bytesOf(m), NOW))).toBe("ROLE_FORBIDDEN");
  });

  it("rol yetkileri: viewer komut veremez; operator varsayılan olarak onay veremez", () => {
    const viewer = makePhone("dev_viewerFFFFFFFFFFFFFFF", "viewer");
    const op = makePhone("dev_operatorGGGGGGGGGGGGG", "operator");
    const w = makeWorld([viewer, op]);
    const to = (p: typeof viewer, m: Parameters<typeof send>[1], body: never) => bytesOf(send(p, m, body, { roster: w.roster }));
    expect(code(() => w.verifier.verify(to(viewer, "cmd.create", { taskId: TASK, text: "x" } as never), NOW))).toBe("ROLE_FORBIDDEN");
    expect(code(() => w.verifier.verify(to(viewer, "history.query", { sinceSeq: 0, limit: 10 } as never), NOW))).toBe("NO_ERROR");
    const decision = { approvalId: TASK, decision: "approve" as const, digest: fakeB64(32), challenge: fakeB64(32), approvalSig: fakeB64(64) };
    expect(code(() => w.verifier.verify(to(op, "approval.decision", decision as never), NOW))).toBe("ROLE_FORBIDDEN");
    expect(code(() => w.verifier.verify(to(op, "grant.request", { path: "C:\\Veri", access: "read", recursive: false } as never), NOW))).toBe(
      "ROLE_FORBIDDEN",
    );
    expect(code(() => w.verifier.verify(to(op, "agent.lockdown", { reason: "telefon kayboldu" } as never), NOW))).toBe("NO_ERROR");

    // Politika ile operator'a onay yetkisi verilebilir
    const pw = makeWorld([op], { policy: { operatorMayApprove: true } });
    expect(code(() => pw.verifier.verify(bytesOf(send(op, "approval.decision", decision, { roster: pw.roster })), NOW))).toBe("NO_ERROR");
  });

  it("yetkisiz mesaj sayaç durumunu ilerletmez", () => {
    const viewer = makePhone("dev_viewerFFFFFFFFFFFFFFF", "viewer");
    const v = makeVerifier([viewer]);
    expect(code(() => v.verify(bytesOf(send(viewer, "cmd.create", { taskId: TASK, text: "x" }, { ctr: 50 })), NOW))).toBe("ROLE_FORBIDDEN");
    // ctr 50 tüketilmedi → aynı sayaçla meşru mesaj "fresh" kabul edilir
    expect(v.verify(bytesOf(send(viewer, "history.query", { sinceSeq: 0, limit: 1 }, { ctr: 50 })), NOW).verdict).toBe("fresh");
  });

  it("çevrimdışı bilgisayar için kuyruğa alınmış komut, imzalı ömrü içinde kabul edilir, sonra reddedilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const fresh = () => new IncomingVerifier(w.ws, w.agent.id, w.roster, new MemoryReplayStore());
    const m = send(p, "cmd.create", { taskId: TASK, text: "x" }, { lifetimeMs: 24 * 3_600_000, roster: w.roster });
    expect(fresh().verify(bytesOf(m), NOW + 23 * 3_600_000).verdict).toBe("fresh");
    expect(code(() => fresh().verify(bytesOf(m), NOW + 25 * 3_600_000))).toBe("MESSAGE_EXPIRED");
  });

  it("özellik: rastgele bayt dizileri hiçbir zaman doğrulamayı geçemez", () => {
    const p = makePhone();
    const v = makeVerifier([p]);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (b) => {
        try {
          v.verify(b, NOW);
          return false;
        } catch (e) {
          return e instanceof ProtocolError;
        }
      }),
      { numRuns: 500 },
    );
  });

  it("özellik: geçerli bir mesajın JSON'unda yapılan rastgele tek karakter değişikliği asla kabul edilmez (yalnızca aynı mesajın tekrarı 'duplicate' olabilir)", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const original = JSON.stringify(send(p, "cmd.create", { taskId: TASK, text: "Raporları özetle" }, { roster: w.roster }));
    fc.assert(
      fc.property(fc.nat({ max: original.length - 1 }), fc.integer({ min: 32, max: 126 }), (pos, ch) => {
        const mutated = original.slice(0, pos) + String.fromCharCode(ch) + original.slice(pos + 1);
        if (mutated === original) return true;
        try {
          const r = new IncomingVerifier(w.ws, w.agent.id, w.roster, new MemoryReplayStore()).verify(
            new TextEncoder().encode(mutated),
            NOW,
          );
          // JSON'da anlamı değiştirmeyen tek değişiklik: aynı içerik (ör. boşluk); imza aynı içeriği kapsar.
          return JSON.stringify(r.msg) === JSON.stringify(JSON.parse(original));
        } catch (e) {
          return e instanceof ProtocolError;
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("ele geçirilmiş relay senaryoları (K5: sunucu kendi başına komut çalıştıramaz)", () => {
  it("relay kendi anahtarıyla telefon adına komut imzalayamaz", () => {
    const phone = makePhone();
    const relayKey = generateSigningKeyPair();
    const forged = send(phone, "cmd.create", { taskId: TASK, text: "Tüm dosyaları sil" }, { signer: relayKey });
    expect(code(() => makeVerifier([phone]).verify(bytesOf(forged), NOW))).toBe("SIGNATURE_INVALID");
  });

  it("relay kendi cihaz kimliğiyle komut gönderemez (eşleştirilmemiş)", () => {
    const phone = makePhone();
    const relay = makePhone("dev_relayServerHHHHHHHHHH");
    expect(code(() => makeVerifier([phone]).verify(bytesOf(send(relay, "cmd.create", { taskId: TASK, text: "x" })), NOW))).toBe(
      "UNKNOWN_SENDER",
    );
  });

  it("relay eski bir komutu tekrar gönderirse yeniden işlenmez; ömrü dolmuşsa reddedilir", () => {
    const phone = makePhone();
    const v = makeVerifier([phone]);
    const m = bytesOf(send(phone, "cmd.create", { taskId: TASK, text: "rapor üret" }));
    expect(v.verify(m, NOW).verdict).toBe("fresh");
    expect(v.verify(m, NOW + 1000).verdict).toBe("duplicate");
    expect(code(() => v.verify(m, NOW + 10 * 60_000))).toBe("MESSAGE_EXPIRED");
  });

  it("relay, başka bir ajana gönderilmiş geçerli komutu bu ajana yönlendiremez", () => {
    const phone = makePhone();
    const forOther = send(phone, "cmd.create", { taskId: TASK, text: "x" }, { to: "dev_digerBilgisayarIIIIII" });
    expect(code(() => makeVerifier([phone]).verify(bytesOf(forOther), NOW))).toBe("WRONG_RECIPIENT");
  });

  it("relay, komutun ömrünü uzatamaz veya tipini değiştiremez (başlık imzalıdır)", () => {
    const phone = makePhone();
    const m = send(phone, "cmd.create", { taskId: TASK, text: "x" });
    const extended = { ...m, hdr: { ...m.hdr, exp: m.hdr.exp + 3_600_000 } };
    expect(code(() => makeVerifier([phone]).verify(bytesOf(extended), NOW))).toBe("SIGNATURE_INVALID");
    const retyped = { ...m, hdr: { ...m.hdr, type: "cmd.cancel" as const }, body: { taskId: TASK } };
    expect(code(() => makeVerifier([phone]).verify(bytesOf(retyped as never), NOW))).toBe("SIGNATURE_INVALID");
  });
});
