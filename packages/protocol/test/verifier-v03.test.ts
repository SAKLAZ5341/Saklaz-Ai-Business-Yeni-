import { beforeAll, describe, expect, it } from "vitest";
import { IncomingVerifier, MemoryReplayStore, ProtocolError, RosterLog } from "../src/index.js";
import { bytesOf, makeAgent, makePhone, makeWorld, NOW, OTHER_WS, send, setup, TASK } from "./helpers.js";

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
const cmd = { taskId: TASK, text: "Excel özetle" };

describe("çalışma alanı izolasyonu (S17)", () => {
  it("geçerli imzalı ama başka alana ait mesaj reddedilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const m = send(p, "cmd.create", cmd, { roster: w.roster, ws: OTHER_WS });
    expect(code(() => w.verifier.verify(bytesOf(m), NOW))).toBe("WRONG_WORKSPACE");
  });

  it("BUSINESS alanının ajanı, PERSONAL alanındaki aynı telefonun anahtarlarını tanımaz", () => {
    const p = makePhone();
    makeWorld([p]); // PERSONAL
    const business = makeWorld([], { ws: OTHER_WS }); // telefon bu alanda kayıtlı değil
    const m = send(p, "cmd.create", cmd, { roster: business.roster, ws: OTHER_WS });
    expect(code(() => business.verifier.verify(bytesOf(m), NOW))).toBe("UNKNOWN_SENDER");
  });
});

describe("cihaz listesi güncelliği (rh)", () => {
  it("telefonun listesi ajandan yeniyse mesaj işlenmez; eksik girişler gelince işlenir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    // Ajan listenin eski bir kopyasını tutuyor
    const agentView = RosterLog.fromEntries(w.roster.all());
    const v = new IncomingVerifier(w.ws, w.agent.id, agentView, new MemoryReplayStore());
    const extra = w.builder.addPhone(makePhone("dev_newerPhone0000000001"));
    const m = send(p, "cmd.create", cmd, { roster: w.roster });
    expect(code(() => v.verify(bytesOf(m), NOW))).toBe("ROSTER_BEHIND");
    agentView.appendOne(extra);
    expect(code(() => v.verify(bytesOf(m), NOW))).toBe("NO_ERROR");
  });

  it("telefonun bildirdiği liste özeti ajanınkinden farklıysa çatallanma olarak reddedilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const m = send(p, "cmd.create", cmd, { rh: { seq: w.roster.head().seq, hash: "B".repeat(42) + "A" } });
    expect(code(() => w.verifier.verify(bytesOf(m), NOW))).toBe("ROSTER_FORK");
  });

  it("geride kalmış ajan, roster.append mesajını rh kontrolüne takılmadan alabilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const agentView = RosterLog.fromEntries(w.roster.all());
    const v = new IncomingVerifier(w.ws, w.agent.id, agentView, new MemoryReplayStore());
    const extra = w.builder.addPhone(makePhone("dev_newerPhone0000000002"));
    const m = send(p, "roster.append", { entries: [extra as never] }, { roster: w.roster });
    expect(code(() => v.verify(bytesOf(m), NOW))).toBe("NO_ERROR");
  });
});

describe("iptal ve cihazlar arası bağlar", () => {
  it("iptal edilen telefon, eski liste başıyla gönderse bile reddedilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const oldHead = w.roster.head();
    w.builder.revoke(p.id);
    const m = send(p, "cmd.create", cmd, { rh: oldHead });
    expect(code(() => w.verifier.verify(bytesOf(m), NOW))).toBe("UNKNOWN_SENDER");
  });

  it("telefon yalnızca bağı olan bilgisayara komut verebilir; bağsız telefon yalnızca liste girişi iletebilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const second = makeAgent("dev_secondComputer0000002");
    w.builder.addAgent(second);
    const v2 = new IncomingVerifier(w.ws, second.id, w.roster, new MemoryReplayStore());
    const m = send(p, "cmd.create", cmd, { roster: w.roster, to: second.id });
    expect(code(() => v2.verify(bytesOf(m), NOW))).toBe("ROLE_FORBIDDEN");
    const r = send(p, "roster.append", { entries: [w.roster.all()[0] as never] }, { roster: w.roster, to: second.id });
    expect(code(() => v2.verify(bytesOf(r), NOW))).toBe("NO_ERROR");
  });
});

describe("geri yükleme (rollback) tabanı (S20, protokol düzeyi)", () => {
  it("geri yükleme tabanından önce zaman damgalı mesajlar reddedilir", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    const old = send(p, "cmd.create", cmd, { roster: w.roster, ts: NOW - 60_000, lifetimeMs: 3_600_000 });
    expect(code(() => w.verifier.verify(bytesOf(old), NOW, { restoreFloorMs: NOW - 1000 }))).toBe("BEFORE_RESTORE_FLOOR");
    const fresh = send(p, "cmd.create", cmd, { roster: w.roster, ts: NOW });
    expect(code(() => w.verifier.verify(bytesOf(fresh), NOW, { restoreFloorMs: NOW - 1000 }))).toBe("NO_ERROR");
  });

  it("çatallanmış listeyle hiçbir mesaj işlenmez", () => {
    const p = makePhone();
    const w = makeWorld([p]);
    (w.roster as unknown as { forked: boolean }).forked = true;
    expect(code(() => w.verifier.verify(bytesOf(send(p, "cmd.create", cmd, { roster: w.roster })), NOW))).toBe("ROSTER_FORK");
  });
});
