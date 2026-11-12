import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { generateSigningKeyPair, toB64 } from "@saklaz/crypto";
import {
  cosignRosterEntry,
  linkRole,
  RosterError,
  RosterLog,
  signRosterEntry,
  type RosterEntry,
} from "../src/index.js";
import { computerDevice, makeAgent, makePhone, phoneDevice, RosterBuilder, setup, WS, OTHER_WS, NOW } from "./helpers.js";

beforeAll(setup);

const rcode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RosterError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};

function base() {
  const owner = makePhone("dev_ownerPhone0000000001", "owner");
  const b = new RosterBuilder(WS, owner);
  return { owner, b };
}

describe("imzalı cihaz listesi — temel", () => {
  it("genesis + bilgisayar + telefon + bağ: zincir yeniden kurulduğunda aynı durum elde edilir", () => {
    const { owner, b } = base();
    const agent = makeAgent();
    const phone2 = makePhone("dev_phoneTwo00000000000001", "operator");
    b.addAgent(agent);
    b.addPhone(phone2);
    b.link(phone2, agent, "operator");
    b.link(owner, agent, "owner");
    const rebuilt = RosterLog.fromEntries(b.log.all());
    expect(rebuilt.head()).toEqual(b.log.head());
    expect(linkRole(rebuilt.current, phone2.id, agent.id)).toBe("operator");
    expect(linkRole(rebuilt.current, owner.id, agent.id)).toBe("owner");
  });

  it("genesis yanlış anahtarla imzalanmışsa veya ikinci genesis gelirse reddedilir", () => {
    const owner = makePhone();
    const other = generateSigningKeyPair();
    const bad = signRosterEntry(
      { ws: WS, seq: 0, prev: "A".repeat(43), ts: NOW, op: "genesis", body: { device: phoneDevice(owner, true), recoveryPub: null, policy: { recoveryDelayHours: 72 } }, signer: owner.id },
      other.secretKey,
    );
    expect(rcode(() => new RosterLog().appendOne(bad))).toBe("ROSTER_SIG");
    const { b } = base();
    const g2 = signRosterEntry({ ...b.draft("genesis", { device: phoneDevice(owner, true), recoveryPub: null, policy: { recoveryDelayHours: 72 } }) }, b.owner.approval.secretKey);
    expect(rcode(() => b.log.appendOne(g2))).toBe("ROSTER_SEQ");
  });

  it("ilk cihaz sahip telefon olmalıdır", () => {
    const agent = makeAgent();
    const g = signRosterEntry(
      { ws: WS, seq: 0, prev: "A".repeat(43), ts: NOW, op: "genesis", body: { device: computerDevice(agent), recoveryPub: null, policy: { recoveryDelayHours: 72 } }, signer: agent.id },
      agent.sign.secretKey,
    );
    expect(rcode(() => new RosterLog().appendOne(g))).toBe("ROSTER_KIND");
  });
});

describe("yetkisiz cihaz eklenememeli (sunucu ele geçirilse bile)", () => {
  it("eklenen cihazın eş-imzası yoksa veya başka anahtarla atılmışsa reddedilir", () => {
    const { b } = base();
    const agent = makeAgent();
    const unsigned = signRosterEntry(b.draft("device.add", { device: computerDevice(agent) }), b.owner.approval.secretKey);
    expect(rcode(() => b.log.appendOne(unsigned))).toBe("ROSTER_COSIG");
    const wrong = cosignRosterEntry(unsigned, generateSigningKeyPair().secretKey);
    expect(rcode(() => b.log.appendOne(wrong))).toBe("ROSTER_COSIG");
  });

  it("relay (veya herhangi bir yabancı) kendi anahtarıyla giriş üretemez", () => {
    const { b } = base();
    const relayKey = generateSigningKeyPair();
    const agent = makeAgent();
    // Sahibin kimliğini taşıyan ama relay anahtarıyla imzalı giriş
    const forged = cosignRosterEntry(signRosterEntry(b.draft("device.add", { device: computerDevice(agent) }), relayKey.secretKey), agent.sign.secretKey);
    expect(rcode(() => b.log.appendOne(forged))).toBe("ROSTER_SIG");
    // Listede olmayan bir "imzalayan"
    const stranger = makePhone("dev_strangerPhone00000001");
    const strangerEntry = signRosterEntry({ ...b.draft("device.add", { device: computerDevice(agent) }), signer: stranger.id }, stranger.approval.secretKey);
    expect(rcode(() => b.log.appendOne(cosignRosterEntry(strangerEntry, agent.sign.secretKey)))).toBe("ROSTER_SIGNER");
  });

  it("sahip olmayan telefon ve bilgisayar giriş imzalayamaz", () => {
    const { b } = base();
    const agent = makeAgent();
    const plain = makePhone("dev_plainPhone000000000001");
    b.addAgent(agent);
    b.addPhone(plain, false);
    const e = signRosterEntry({ ...b.draft("link.set", { phoneId: plain.id, computerId: agent.id, role: "owner" }), signer: plain.id }, plain.approval.secretKey);
    expect(rcode(() => b.log.appendOne(e))).toBe("ROSTER_SIGNER");
    const e2 = signRosterEntry({ ...b.draft("link.set", { phoneId: plain.id, computerId: agent.id, role: "owner" }), signer: agent.id }, agent.sign.secretKey);
    expect(rcode(() => b.log.appendOne(e2))).toBe("ROSTER_SIGNER");
  });

  it("onay anahtarı yerine komut anahtarıyla imzalanan giriş reddedilir (biyometrik anahtar şartı)", () => {
    const { b } = base();
    const agent = makeAgent();
    const e = cosignRosterEntry(signRosterEntry(b.draft("device.add", { device: computerDevice(agent) }), b.owner.sign.secretKey), agent.sign.secretKey);
    expect(rcode(() => b.log.appendOne(e))).toBe("ROSTER_SIG");
  });
});

describe("iptal edilmiş cihazın anahtarları yeniden kullanılamaz", () => {
  it("aynı kimlikle, ya da yeni kimlik ama eski anahtarlarla yeniden ekleme reddedilir", () => {
    const { b } = base();
    const lost = makePhone("dev_lostPhone0000000000001");
    b.addPhone(lost);
    b.revoke(lost.id);
    expect(rcode(() => b.addPhone(lost))).toBe("ROSTER_KEY_REVOKED");
    const reborn = { ...lost, id: "dev_rebornPhone00000000001" };
    expect(rcode(() => b.addPhone(reborn))).toBe("ROSTER_KEY_REVOKED");
    // Eski anahtarlardan yalnızca biri bile yeterli
    const partial = { ...makePhone("dev_partialPhone0000000001"), approval: lost.approval };
    expect(rcode(() => b.addPhone(partial))).toBe("ROSTER_KEY_REVOKED");
    // Yeni anahtarlarla yeni cihaz kabul edilir
    expect(rcode(() => b.addPhone(makePhone("dev_newPhone00000000000001")))).toBe("NO_ERROR");
  });

  it("iptal, cihazın tüm güven bağlarını kaldırır ve tekrar iptal reddedilir", () => {
    const { b } = base();
    const agent = makeAgent();
    const p = makePhone("dev_linkedPhone00000000001");
    b.addAgent(agent);
    b.addPhone(p);
    b.link(p, agent, "operator");
    b.revoke(p.id);
    expect(linkRole(b.log.current, p.id, agent.id)).toBeUndefined();
    expect(rcode(() => b.revoke(p.id))).toBe("ROSTER_UNKNOWN_DEVICE");
    b.revoke(agent.id);
    expect(rcode(() => b.link(b.owner, agent, "owner"))).toBe("ROSTER_UNKNOWN_DEVICE");
  });

  it("aynı anahtar iki etkin cihazda kullanılamaz; aynı kimlik iki kez eklenemez", () => {
    const { b } = base();
    const a = makePhone("dev_phoneAAA000000000001");
    b.addPhone(a);
    const clone = { ...makePhone("dev_phoneClone0000000001"), dh: a.dh };
    expect(rcode(() => b.addPhone(clone))).toBe("ROSTER_DUP_KEY");
    expect(rcode(() => b.addPhone({ ...makePhone(a.id) }))).toBe("ROSTER_DUP_DEVICE");
  });

  it("son sahip iptal edilemez (alan yönetilemez kalır); ikinci sahip varsa edilebilir", () => {
    const { owner, b } = base();
    expect(rcode(() => b.revoke(owner.id))).toBe("ROSTER_LAST_OWNER");
    const backup = makePhone("dev_backupTablet000000001");
    b.addPhone(backup, true);
    expect(rcode(() => b.revoke(owner.id))).toBe("NO_ERROR");
    // İptal edilen sahip artık imzalayamaz
    expect(rcode(() => b.addPhone(makePhone("dev_afterRevoke0000000001")))).toBe("ROSTER_SIGNER");
  });
});

describe("cihazlar arası güven ilişkileri ayrı ayrı", () => {
  it("bir telefonun her bilgisayardaki rolü bağımsızdır", () => {
    const { b } = base();
    const home = makeAgent("dev_homeComputer000000001");
    const work = makeAgent("dev_secondComputer0000001");
    const p = makePhone("dev_myPhone00000000000001");
    b.addAgent(home);
    b.addAgent(work);
    b.addPhone(p);
    b.link(p, home, "owner");
    b.link(p, work, "viewer");
    expect(linkRole(b.log.current, p.id, home.id)).toBe("owner");
    expect(linkRole(b.log.current, p.id, work.id)).toBe("viewer");
    b.next("link.remove", { phoneId: p.id, computerId: work.id });
    expect(linkRole(b.log.current, p.id, work.id)).toBeUndefined();
    expect(linkRole(b.log.current, p.id, home.id)).toBe("owner");
  });

  it("bağ yalnızca telefon→bilgisayar yönünde kurulabilir", () => {
    const { b } = base();
    const a = makeAgent();
    const p = makePhone("dev_phoneKind00000000001");
    b.addAgent(a);
    b.addPhone(p);
    expect(rcode(() => b.next("link.set", { phoneId: a.id, computerId: p.id, role: "owner" }))).toBe("ROSTER_KIND");
  });
});

describe("zincir bütünlüğü ve çatallanma", () => {
  it("yanlış önceki özet, boşluk, başka alan ve imza sonrası değiştirilmiş gövde reddedilir", () => {
    const { b } = base();
    const agent = makeAgent();
    const d = b.draft("device.add", { device: computerDevice(agent) });
    const mk = (over: Partial<typeof d>) => cosignRosterEntry(signRosterEntry({ ...d, ...over }, b.owner.approval.secretKey), agent.sign.secretKey);
    expect(rcode(() => b.log.appendOne(mk({ prev: toB64(new Uint8Array(32).fill(1)) })))).toBe("ROSTER_PREV");
    expect(rcode(() => b.log.appendOne(mk({ seq: d.seq + 1 })))).toBe("ROSTER_GAP");
    expect(rcode(() => b.log.appendOne(mk({ ws: OTHER_WS })))).toBe("ROSTER_WS");
    const good = mk({});
    const tampered = { ...good, body: { device: { ...computerDevice(agent), label: "Değiştirildi" } } };
    expect(rcode(() => b.log.appendOne(tampered))).toBe("ROSTER_SIG");
    expect(b.log.appendOne(good)).toBe("appended");
    expect(b.log.appendOne(good)).toBe("known"); // aynı giriş tekrar gelirse sorun değil
  });

  it("aynı sırada farklı giriş çatallanmadır: liste kilitlenir ve yeni giriş kabul edilmez", () => {
    const { b } = base();
    const a1 = makeAgent("dev_forkComputerA00000001");
    const a2 = makeAgent("dev_forkComputerB00000001");
    const d = b.draft("device.add", { device: computerDevice(a1) });
    const e1 = cosignRosterEntry(signRosterEntry(d, b.owner.approval.secretKey), a1.sign.secretKey);
    const e2 = cosignRosterEntry(signRosterEntry({ ...d, body: { device: computerDevice(a2) } }, b.owner.approval.secretKey), a2.sign.secretKey);
    b.log.appendOne(e1);
    expect(rcode(() => b.log.appendOne(e2))).toBe("ROSTER_FORK");
    expect(b.log.isForked).toBe(true);
    expect(rcode(() => b.log.appendOne(e1))).toBe("ROSTER_FORKED_LOCKED");
  });

  it("sabitlenmiş liste başı uyuşmazsa yeniden kurma reddedilir", () => {
    const { b } = base();
    b.addAgent(makeAgent());
    expect(rcode(() => RosterLog.fromEntries(b.log.all(), { seq: 1, hash: "B".repeat(43) }))).toBe("ROSTER_PIN_MISMATCH");
    expect(rcode(() => RosterLog.fromEntries(b.log.all(), { seq: 5, hash: b.log.head().hash }))).toBe("ROSTER_PIN_MISMATCH");
    expect(rcode(() => RosterLog.fromEntries(b.log.all(), b.log.head()))).toBe("NO_ERROR");
  });

  it("desteklenmeyen işlem (kurtarma Sprint 6'da) ve bozuk şema reddedilir; boş liste başı -1'dir", () => {
    const { b } = base();
    const e = signRosterEntry({ ...b.draft("link.set", {}), op: "recovery.request" as never }, b.owner.approval.secretKey);
    expect(rcode(() => b.log.appendOne(e))).toBe("ROSTER_UNSUPPORTED_OP");
    expect(rcode(() => b.log.appendOne({ v: 1 }))).toBe("ROSTER_SCHEMA");
    const bad = signRosterEntry(b.draft("link.set", { phoneId: "x" }), b.owner.approval.secretKey);
    expect(rcode(() => b.log.appendOne(bad))).toBe("ROSTER_SCHEMA");
    const empty = new RosterLog();
    expect(empty.head().seq).toBe(-1);
    expect(rcode(() => empty.current)).toBe("ROSTER_SEQ");
  });

  it("yalnızca device.add eş-imza taşıyabilir", () => {
    const { b } = base();
    const agent = makeAgent();
    b.addAgent(agent);
    const link = signRosterEntry(b.draft("link.set", { phoneId: b.owner.id, computerId: agent.id, role: "owner" }), b.owner.approval.secretKey);
    expect(rcode(() => b.log.appendOne(cosignRosterEntry(link, agent.sign.secretKey)))).toBe("ROSTER_SCHEMA");
    expect(b.log.appendOne(link)).toBe("appended");
  });

  it("özellik: geçerli bir girişin JSON'unda tek karakter değişikliği, farklı içerikle asla kabul edilmez", () => {
    const { b } = base();
    const agent = makeAgent();
    const entry: RosterEntry = cosignRosterEntry(signRosterEntry(b.draft("device.add", { device: computerDevice(agent) }), b.owner.approval.secretKey), agent.sign.secretKey);
    const original = JSON.stringify(entry);
    const snapshot = b.log.all();
    fc.assert(
      fc.property(fc.nat({ max: original.length - 1 }), fc.integer({ min: 32, max: 126 }), (pos, ch) => {
        const mutated = original.slice(0, pos) + String.fromCharCode(ch) + original.slice(pos + 1);
        if (mutated === original) return true;
        let parsed: unknown;
        try {
          parsed = JSON.parse(mutated);
        } catch {
          return true;
        }
        const log = RosterLog.fromEntries(snapshot);
        try {
          log.appendOne(parsed);
          return JSON.stringify(parsed) === original;
        } catch (e) {
          return e instanceof RosterError;
        }
      }),
      { numRuns: 1500 },
    );
  });
});
