/**
 * VaultLock — gerçek süreçlerle: canlı sahibin kilidi alınamaz; sahibi gerçekten öldürülünce (SIGKILL /
 * Windows'ta TerminateProcess) devralınır; iki (ve çok) süreçli yarışta HER TURDA tam bir sahip olur ve
 * kaybedenler kazananın kilidini silemez. Ayrıca devralmanın içerik doğrulaması ve yazım çiti.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EncryptedFileVault, VaultLock } from "../src/app/filevault.js";

let dir: string;
let child: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "saklaz-vlock-"));
  child = join(dir, "vaultlock-child.mjs");
  await build({ entryPoints: [join(import.meta.dirname, "fixtures", "vaultlock-child.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: child, logLevel: "warning" });
});
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

interface RaceOut {
  pid: number;
  ok: boolean;
  code: string | null;
  content: string | null;
}

function run(args: string[]): { proc: ChildProcess; lines: Promise<string[]>; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  let out = "";
  let err = "";
  proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  proc.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const lines = exited.then(() => {
    if (err.trim()) throw new Error(`alt süreç hata yazdı: ${err}`);
    return out.trim().split("\n").filter(Boolean);
  });
  return { proc, lines, exited };
}

async function holdingChild(lock: string): Promise<{ proc: ChildProcess; content: string; exited: Promise<number | null> }> {
  const proc = spawn(process.execPath, [child, "hold", lock], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const content = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const m = /^HELD (.*)$/m.exec(buf);
      if (m?.[1]) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error("hold süreci erken bitti")));
  });
  return { proc, content, exited };
}

/** n süreç aynı anda kilidi almaya çalışır. */
async function race(lock: string, n: number, holdMs = 400): Promise<{ results: RaceOut[]; releases: { pid: number; stillMine: boolean }[] }> {
  // Süreçlerin başlaması için pay (Windows'ta süreç başlatma daha yavaş); sonra döngüyle aynı anda.
  const startAt = Date.now() + (process.platform === "win32" ? 2500 : 900);
  const runs = Array.from({ length: n }, () => run(["race", lock, String(startAt), String(holdMs)]));
  const all = await Promise.all(runs.map((r) => r.lines));
  const parsed = all.flat().map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    results: parsed.filter((p) => "ok" in p) as unknown as RaceOut[],
    releases: parsed.filter((p) => "released" in p) as unknown as { pid: number; stillMine: boolean }[],
  };
}

function leftovers(d: string): string[] {
  return readdirSync(d).filter((f) => f.startsWith("vault.lock") && f !== "vault.lock");
}

describe("VaultLock — gerçek alt süreçler", () => {
  it("canlı sahibin kilidi alınamaz; sahibi SIGKILL ile öldürülünce devralınır", { timeout: 180_000 }, async () => {
    const d = mkdtempSync(join(dir, "kill-"));
    const lock = join(d, "vault.lock");
    const h = await holdingChild(lock);
    expect((JSON.parse(h.content) as { pid: number }).pid).toBe(h.proc.pid);
    expect(() => VaultLock.acquire(lock)).toThrow("VAULT_LOCKED");
    expect(readFileSync(lock, "utf8")).toBe(h.content); // canlı sahibin kilidine dokunulmadı
    expect(h.proc.kill("SIGKILL")).toBe(true);
    await h.exited;
    expect(VaultLock.isStale(lock)).toBe(true);
    const mine = VaultLock.acquire(lock);
    expect((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid).toBe(process.pid);
    mine.release();
    expect(existsSync(lock)).toBe(false);
    expect(leftovers(d)).toEqual([]);
  });

  it("iki süreçli yarış, boş kilit: her turda TAM BİR kazanan; kaybeden VAULT_LOCKED; kazanan sonuna kadar sahip", { timeout: 180_000 }, async () => {
    const d = mkdtempSync(join(dir, "free-"));
    const lock = join(d, "vault.lock");
    for (let round = 0; round < 10; round++) {
      const { results, releases } = await race(lock, 2);
      const winners = results.filter((r) => r.ok);
      expect(winners, `tur ${round}`).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(["VAULT_LOCKED"]);
      expect((JSON.parse(winners[0]?.content ?? "{}") as { pid: number }).pid).toBe(winners[0]?.pid);
      expect(releases).toEqual([{ pid: winners[0]?.pid, released: true, stillMine: true }]);
      expect(existsSync(lock)).toBe(false);
      expect(leftovers(d)).toEqual([]);
    }
  });

  it("iki süreçli yarış, ÖLDÜRÜLMÜŞ sürecin eski kilidi: her turda tam bir süreç devralır, diğeri kazananın kilidini silemez", { timeout: 180_000 }, async () => {
    const d = mkdtempSync(join(dir, "stale-"));
    const lock = join(d, "vault.lock");
    const h = await holdingChild(lock);
    h.proc.kill("SIGKILL");
    await h.exited;
    const staleContent = h.content; // gerçekten ölmüş sürecin kilidi
    for (let round = 0; round < 10; round++) {
      writeFileSync(lock, staleContent);
      const { results, releases } = await race(lock, 2);
      const winners = results.filter((r) => r.ok);
      expect(winners, `tur ${round}: ${JSON.stringify(results)}`).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(["VAULT_LOCKED"]);
      // kazanan, tuttuğu süre boyunca kilidin sahibi kaldı (kaybeden onun kilidini silmedi/değiştirmedi)
      expect(releases).toEqual([{ pid: winners[0]?.pid, released: true, stillMine: true }]);
      expect(existsSync(lock)).toBe(false);
      expect(leftovers(d)).toEqual([]);
    }
  });

  it("çok süreçli yarış (6 süreç), eski kilit: her turda tam bir sahip", { timeout: 180_000 }, async () => {
    const d = mkdtempSync(join(dir, "many-"));
    const lock = join(d, "vault.lock");
    const dead = JSON.stringify({ pid: await deadPid(), host: hostname(), token: "olu", ts: 1 });
    for (let round = 0; round < 4; round++) {
      writeFileSync(lock, dead);
      const { results, releases } = await race(lock, 6);
      expect(results.filter((r) => r.ok), `tur ${round}`).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => r.code === "VAULT_LOCKED")).toBe(true);
      expect(releases).toHaveLength(1);
      expect(releases[0]?.stillMine).toBe(true);
      expect(leftovers(d)).toEqual([]);
    }
  });
});

async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  return p.pid ?? 0;
}

describe("VaultLock — devralmanın içerik doğrulaması ve çit", () => {
  it("eski kilit görüldükten SONRA kilit yenilendiyse devralma yeni kilidi SİLMEZ", async () => {
    const d = mkdtempSync(join(dir, "snap-"));
    const lock = join(d, "vault.lock");
    const stale = Buffer.from(JSON.stringify({ pid: await deadPid(), host: hostname(), token: "eski", ts: 1 }));
    const fresh = JSON.stringify({ pid: process.ppid, host: hostname(), token: "yeni", ts: 2 });
    writeFileSync(lock, fresh); // arada başka süreç eskiyi devralıp yeni kilit almış
    expect(VaultLock.reclaimIfUnchanged(lock, stale)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    writeFileSync(lock, stale);
    expect(VaultLock.reclaimIfUnchanged(lock, stale)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(leftovers(d)).toEqual([]);
  });

  it("devralma kilidi canlı bir süreçteyse beklenir (dokunulmaz); çökmüş süreçteyse temizlenir", async () => {
    const d = mkdtempSync(join(dir, "guard-"));
    const lock = join(d, "vault.lock");
    const stale = Buffer.from(JSON.stringify({ pid: await deadPid(), host: hostname(), token: "eski", ts: 1 }));
    writeFileSync(lock, stale);
    const liveGuard = JSON.stringify({ pid: process.ppid, host: hostname(), token: "g", ts: 1 });
    writeFileSync(`${lock}.reclaim`, liveGuard);
    expect(VaultLock.reclaimIfUnchanged(lock, stale)).toBe(false);
    expect(readFileSync(`${lock}.reclaim`, "utf8")).toBe(liveGuard);
    expect(() => VaultLock.acquire(lock)).toThrow("VAULT_LOCKED");
    writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "g2", ts: 1 }));
    const l = VaultLock.acquire(lock);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    l.release();
    expect(leftovers(d)).toEqual([]);
  });

  it("çit: kilit başkasına geçtiyse kasa yazmaz (VAULT_LOCK_LOST), disk değişmez, close başkasının kilidini silmez", () => {
    const d = mkdtempSync(join(dir, "fence-"));
    const p = join(d, "vault.bin");
    const v = new EncryptedFileVault(p, randomBytes(32), "personal");
    v.set("a", Uint8Array.of(1));
    const before = readFileSync(p);
    const other = JSON.stringify({ pid: process.ppid, host: hostname(), token: "baskasi", ts: 1 });
    writeFileSync(join(d, "vault.lock"), other);
    expect(() => {
      v.set("b", Uint8Array.of(2));
    }).toThrow("VAULT_LOCK_LOST");
    expect(() => {
      v.delete("a");
    }).toThrow("VAULT_LOCK_LOST");
    expect(readFileSync(p).equals(before)).toBe(true);
    expect(v.get("b")).toBeUndefined();
    v.close();
    expect(readFileSync(join(d, "vault.lock"), "utf8")).toBe(other);
  });
});
