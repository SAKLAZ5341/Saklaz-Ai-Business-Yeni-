import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSas, fromB64, initCrypto } from "@saklaz/crypto";
import type { WireOut } from "@saklaz/protocol";
import { PhoneSim, toFrames } from "@saklaz/testkit";
import { AgentCore, MemoryVault, openAgentDb, type LocalAuthenticator } from "../src/index.js";

beforeAll(initCrypto);

const WS = "ws_personalTestWS000001";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "saklaz-agent-"));
  dirs.push(d);
  return d;
}

class Clock {
  t = 1_794_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const yes: LocalAuthenticator = { verify: () => Promise.resolve(true) };
const no: LocalAuthenticator = { verify: () => Promise.resolve(false) };

function setup(opts: { dir?: string; vault?: MemoryVault; clock?: Clock } = {}) {
  const dir = opts.dir ?? tempDir();
  const vault = opts.vault ?? new MemoryVault();
  const clock = opts.clock ?? new Clock();
  let lockdownCalls = 0;
  const agent = new AgentCore({ dbPath: join(dir, "agent.db"), vault, now: clock.now, onLockdown: () => lockdownCalls++, label: "Ev bilgisayarı" });
  return { dir, vault, clock, agent, lockdownCalls: () => lockdownCalls };
}

/** Telefon ile ajanı doğrudan birbirine bağlayan yardımcı (relay yok). */
function deliverToAgent(agent: AgentCore, phone: PhoneSim, outs: WireOut[]) {
  const r = agent.processIncoming(toFrames(phone.id, outs));
  const back = phone.receive(toFrames(agent.deviceId, r.out));
  if (back.length) agent.processIncoming(toFrames(phone.id, back));
  return r;
}

function pair(agent: AgentCore, phone: PhoneSim, clock: Clock) {
  phone.createWorkspace();
  const qr = agent.startPairing();
  const req = phone.scanQr(qr, "Ev bilgisayarı");
  const r = agent.processIncoming(toFrames(phone.id, [req]));
  expect(r.rejected).toEqual([]);
  // Telefon kendi tarafında SAS'ı hesaplar; kullanıcı iki ekranı karşılaştırır.
  const phoneSas = computeSas({
    secret: fromB64(qr.secret),
    agentSignPub: fromB64(qr.signPub),
    agentDhPub: fromB64(qr.dhPub),
    phoneSignPub: phone.sign.publicKey,
    phoneDhPub: phone.dh.publicKey,
  });
  expect(agent.pairingSas()).toBe(phoneSas);
  const ok = agent.confirmPairing(true);
  if (!ok) throw new Error("eşleştirme onayı üretilmedi");
  const link = phone.completePairing(ok.ct);
  clock.advance(1000);
  const ra = deliverToAgent(agent, phone, phone.send(agent.deviceId, "roster.append", { entries: link as never }));
  expect(ra.rejected).toEqual([]);
  return { qr };
}

const TASK = "01934b6e-0000-7000-8000-000000000001";

describe("eşleştirme (QR + SAS, cihaz listesi)", () => {
  it("başarılı eşleştirme: liste kurulur, bağ yazılır, imzalı komut kabul edilir ve telefona imzalı yanıt döner", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000001", WS, clock.now);
    pair(agent, phone, clock);
    expect(agent.workspaceId).toBe(WS);
    expect(agent.rosterHead?.seq).toBe(2); // genesis, device.add(bilgisayar), link.set
    const r = deliverToAgent(agent, phone, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "Excel özetle" }));
    expect(r.accepted.map((m) => m.hdr.type)).toEqual(["cmd.create"]);
    const types = phone.inbox.map((m) => m.hdr.type);
    expect(types).toContain("ack");
    expect(types).toContain("task.event");
    expect(agent.audit.verify().ok).toBe(true);
  });

  it("SAS uyuşmazsa eşleştirme tamamlanmaz ve hiçbir liste kurulmaz", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000002", WS, clock.now);
    phone.createWorkspace();
    const qr = agent.startPairing();
    agent.processIncoming(toFrames(phone.id, [phone.scanQr(qr)]));
    expect(agent.confirmPairing(false)).toBeUndefined();
    expect(agent.rosterHead).toBeUndefined();
    expect(agent.audit.all().some((a) => a.action === "pairing.failed")).toBe(true);
  });

  it("eşleştirme sırrını bilmeyen biri (ör. relay) istek gönderemez; tek hatalı deneme oturumu kapatır", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000003", WS, clock.now);
    phone.createWorkspace();
    const qr = agent.startPairing();
    const forged = phone.scanQr({ ...qr, secret: "A".repeat(43) });
    const r = agent.processIncoming(toFrames(phone.id, [forged]));
    expect(r.rejected[0]?.code).toBe("PAIRING_INVALID");
    // Doğru sırla gelen sonraki istek de reddedilir: oturum kapandı
    const r2 = agent.processIncoming(toFrames(phone.id, [phone.scanQr(qr)]));
    expect(r2.rejected[0]?.code).toBe("NO_PAIRING");
  });

  it("ekleme girişi BU bilgisayarı tanımlamıyorsa (başka anahtar) eşleştirme reddedilir", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000004", WS, clock.now);
    phone.createWorkspace();
    const qr = agent.startPairing();
    // Relay QR içeriğini göremez; ancak telefonun yanlış QR okuması veya kurcalanmış QR durumunu taklit ediyoruz.
    const otherKey = Buffer.from(new PhoneSim("dev_unrelatedDevice000001", WS).dh.publicKey).toString("base64url");
    const swapped = phone.scanQr({ ...qr, dhPub: otherKey });
    expect(agent.processIncoming(toFrames(phone.id, [swapped])).rejected[0]?.code).toBe("PAIRING_INVALID");
  });

  it("süresi dolmuş eşleştirme oturumu reddedilir", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000005", WS, clock.now);
    phone.createWorkspace();
    const qr = agent.startPairing();
    clock.advance(6 * 60_000);
    expect(agent.processIncoming(toFrames(phone.id, [phone.scanQr(qr)])).rejected[0]?.code).toBe("NO_PAIRING");
  });
});

describe("acil kilit (S21)", () => {
  it("telefondan kilit: bağlantı kesme çağrılır, sonraki her mesaj reddedilir, yeniden başlatmada sürer, yalnızca yerelde açılır", async () => {
    const { agent, clock, dir, vault, lockdownCalls } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000010", WS, clock.now);
    pair(agent, phone, clock);
    deliverToAgent(agent, phone, phone.send(agent.deviceId, "agent.lockdown", { reason: "telefon kayboldu" }));
    expect(agent.lockdown.locked).toBe(true);
    expect(lockdownCalls()).toBe(1);
    const r = agent.processIncoming(toFrames(phone.id, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" })));
    expect(r.rejected.every((x) => x.code === "LOCKED")).toBe(true);
    agent.close();

    const again = setup({ dir, vault, clock }).agent;
    expect(again.lockdown.locked).toBe(true);
    expect(await again.releaseLockdown(no)).toBe(false);
    expect(again.lockdown.locked).toBe(true);
    expect(await again.releaseLockdown(yes)).toBe(true);
    expect(again.lockdown.locked).toBe(false);
    const acts = again.audit.all().map((a) => a.action);
    expect(acts).toContain("lockdown.release_denied");
    expect(acts).toContain("lockdown.released");
    again.close();
  });

  it("kuyruktan toplu gelen mesajlarda kilit, kendisinden ÖNCE gönderilmiş komutlardan önce uygulanır", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000011", WS, clock.now);
    pair(agent, phone, clock);
    // Bilgisayar çevrimdışıyken kuyrukta birikenler: iki komut, sonra acil kilit
    const queued = [
      ...phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "rapor 1" }, { lifetimeMs: 3_600_000 }),
      ...phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "rapor 2" }, { lifetimeMs: 3_600_000 }),
      ...phone.send(agent.deviceId, "agent.lockdown", { reason: "acil" }, { lifetimeMs: 3_600_000 }),
    ];
    clock.advance(30 * 60_000);
    const r = agent.processIncoming(toFrames(phone.id, queued));
    expect(r.accepted.map((m) => m.hdr.type)).toEqual(["agent.lockdown"]);
    expect(r.rejected.filter((x) => x.code === "LOCKED")).toHaveLength(2);
  });

  it("yerel kilit sunucudan bağımsızdır ve aynı etkiyi yapar", () => {
    const { agent, clock, lockdownCalls } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000012", WS, clock.now);
    pair(agent, phone, clock);
    agent.engageLocalLockdown("masaüstü ACİL DURDUR");
    expect(lockdownCalls()).toBe(1);
    expect(agent.processIncoming(toFrames(phone.id, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" }))).rejected[0]?.code).toBe("LOCKED");
  });
});

describe("geri yükleme (rollback) koruması (S20)", () => {
  it("eski veritabanı yedeği geri yüklenirse, yedekten sonra işlenmiş komut tekrar oynatıldığında reddedilir", () => {
    const { agent, clock, dir, vault } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000020", WS, clock.now);
    pair(agent, phone, clock);
    agent.close();
    const backup = join(dir, "backup.db");
    copyFileSync(join(dir, "agent.db"), backup); // 1) yedek alındı

    let a = setup({ dir, vault, clock }).agent;
    clock.advance(60_000);
    // 2) Yedekten SONRA bir komut işlendi. Ajan yeniden başladığı için oturum yok; telefon da oturumunu
    //    bırakır ve mühürlü zarf gönderir (kuyruğa alınmış mesaj davranışı).
    phone.channel?.dropPeer(a.deviceId);
    const frames = toFrames(phone.id, phone.send(a.deviceId, "cmd.create", { taskId: TASK, text: "1 dosya sil" }, { lifetimeMs: 3_600_000 }));
    const sealedOnly = frames.filter((f) => f.kind === "sealed");
    expect(a.processIncoming(sealedOnly).accepted).toHaveLength(1);
    a.close();

    // 3) Saldırgan/hatalı işlem: eski yedek geri yüklendi; relay aynı şifreli çerçeveyi tekrar gönderiyor
    copyFileSync(backup, join(dir, "agent.db"));
    clock.advance(60_000);
    a = setup({ dir, vault, clock }).agent;
    expect(a.startup.restoreDetected).toBe(true);
    const r = a.processIncoming(sealedOnly);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.code).toBe("BEFORE_RESTORE_FLOOR");
    expect(a.audit.all().some((x) => x.action === "restore.detected")).toBe(true);
    // Geri yükleme sonrası YENİ komutlar normal çalışır
    phone.channel?.dropPeer(a.deviceId);
    const fresh = toFrames(phone.id, phone.send(a.deviceId, "cmd.create", { taskId: TASK, text: "yeni" })).filter((f) => f.kind === "sealed");
    expect(a.processIncoming(fresh).accepted).toHaveLength(1);
    a.close();
  });

  it("karşılaştırma: geri yükleme yoksa aynı çerçeve 'yinelenen' olarak tanınır ve yeniden işlenmez", () => {
    const { agent, clock, dir, vault } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000021", WS, clock.now);
    pair(agent, phone, clock);
    phone.channel?.dropPeer(agent.deviceId);
    const sealed = toFrames(phone.id, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" })).filter((f) => f.kind === "sealed");
    agent.close();
    const a = setup({ dir, vault, clock }).agent;
    expect(a.startup.restoreDetected).toBe(false);
    expect(a.processIncoming(sealed).accepted).toHaveLength(1);
    expect(a.processIncoming(sealed).accepted).toHaveLength(0);
    a.close();
  });

  it("veritabanı yanlış anahtarla açılamaz (kasa olmadan dosya okunamaz)", () => {
    const { agent, dir } = setup();
    agent.close();
    expect(() => openAgentDb(join(dir, "agent.db"), new MemoryVault())).toThrow();
  });
});

describe("iptal ve yerel engelleme", () => {
  it("sahip telefonun imzaladığı iptal girişinden sonra iptal edilen telefonun komutları reddedilir", () => {
    const { agent, clock } = setup();
    const owner = new PhoneSim("dev_phoneOwner0000000030", WS, clock.now);
    pair(agent, owner, clock);
    const second = new PhoneSim("dev_phoneSecond000000030", WS, clock.now);
    const addC = owner.ownerAdd(second.device(false), second.sign.secretKey);
    const link = owner.ownerEntry("link.set", { phoneId: second.id, computerId: agent.deviceId, role: "operator" });
    deliverToAgent(agent, owner, owner.send(agent.deviceId, "roster.append", { entries: [addC, link] as never }));
    second.syncRosterFrom(owner);
    expect(deliverToAgent(agent, second, second.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "ikinci telefon" })).accepted).toHaveLength(1);

    const revoke = owner.ownerEntry("device.revoke", { deviceId: second.id, reason: "kayboldu" });
    deliverToAgent(agent, owner, owner.send(agent.deviceId, "roster.append", { entries: [revoke] as never }));
    const r = agent.processIncoming(toFrames(second.id, second.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "çalınan telefondan" })));
    expect(r.accepted).toHaveLength(0);
  });

  it("yerel engelleme, cihaz listesinden ve sunucudan bağımsız olarak o cihazı reddeder", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000031", WS, clock.now);
    pair(agent, phone, clock);
    agent.localDeny(phone.id, "şüpheli etkinlik");
    const r = agent.processIncoming(toFrames(phone.id, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" })));
    expect(r.rejected.every((x) => x.code === "LOCAL_DENY")).toBe(true);
  });

  it("listesi geride olan ajan, eksik girişleri imzalı roster.need ile ister", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000032", WS, clock.now);
    pair(agent, phone, clock);
    phone.ownerEntry("link.set", { phoneId: phone.id, computerId: agent.deviceId, role: "operator" }); // ajana iletilmedi
    deliverToAgent(agent, phone, phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" }));
    const need = phone.inbox.find((m) => m.hdr.type === "roster.need");
    expect(need?.body).toEqual({ fromSeq: 3 });
  });
});

describe("denetim kaydı ve sunucu davranışları", () => {
  it("denetim kaydında bir satır değiştirilirse zincir doğrulaması bozulmayı tespit eder", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000040", WS, clock.now);
    pair(agent, phone, clock);
    expect(agent.audit.verify().ok).toBe(true);
    agent.db.prepare("UPDATE audit SET details = ? WHERE id = 2").run(JSON.stringify({ sahte: true }));
    expect(agent.audit.verify()).toEqual({ ok: false, brokenAt: 2 });
    const head = agent.audit.signedHead(agent.sign);
    expect(head.sig.length).toBe(86);
  });

  it("relay bir Noise mesajını düşürürse: sonraki mesaj çözülemez, oturum sıfırlanır, telefon yeniden gönderince kabul edilir (S23)", () => {
    const { agent, clock } = setup();
    const phone = new PhoneSim("dev_phoneSimulator000041", WS, clock.now);
    pair(agent, phone, clock);
    // pair() sonrası oturum kurulu: telefonun mesajları "noise" türünde
    const m1 = phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "bir" });
    expect(m1.map((o) => o.kind)).toEqual(["noise"]);
    const m2 = phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "iki" });
    // m1 relay tarafından düşürüldü; m2 geliyor
    const r = agent.processIncoming(toFrames(phone.id, m2));
    expect(r.accepted).toHaveLength(0);
    expect(r.out.map((o) => o.kind)).toContain("hs1"); // ajan yeni oturum istiyor
    // Telefon yeni oturumu kurar ve teslim onayı almadığı mesajları yeniden gönderir (yeni sayaçla)
    const hs2 = phone.receive(toFrames(agent.deviceId, r.out));
    const r2 = agent.processIncoming(toFrames(phone.id, hs2));
    expect(r2.rejected).toEqual([]);
    const resend = phone.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "bir (tekrar)" });
    expect(agent.processIncoming(toFrames(phone.id, resend)).accepted).toHaveLength(1);
  });

  it("zarf göndereni ile imzalı başlıktaki gönderen farklıysa reddedilir (relay yönlendirme hilesi)", () => {
    const { agent, clock } = setup();
    const a = new PhoneSim("dev_phoneSimulator000042", WS, clock.now);
    pair(agent, a, clock);
    const frames = toFrames("dev_relayClaimsOther00001", a.send(agent.deviceId, "cmd.create", { taskId: TASK, text: "x" }));
    const r = agent.processIncoming(frames);
    expect(r.accepted).toHaveLength(0);
  });
});
