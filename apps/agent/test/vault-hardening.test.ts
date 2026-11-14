/**
 * Kasa ve token güvenliği regresyon testleri (PR #13 düzeltmeleri):
 * vault.lock, eski kilit kurtarma, atomik yazım ve yazım hatasında tutarlılık, geçici dosya temizliği,
 * düz metin tamponların sıfırlanması, openVault/servis hatasında KEK sıfırlama, yenileme token'ı
 * tamponlarının sıfırlanması, eşleştirmede arka plan görevi ve QR dosyası temizliği.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { initCrypto, randomBytes } from "@saklaz/crypto";
import {
  AgentService,
  EncryptedFileVault,
  LOCK_UNREADABLE_STALE_MS,
  openVault,
  PAIRING_QR_FILE,
  ProtectedKeyStore,
  runPairing,
  VaultError,
  VaultLock,
  withBackgroundTaskPaused,
  type PairingIo,
  type PairingService,
} from "../src/index.js";
import { FakeProtector } from "./fake-protector.js";

beforeAll(initCrypto);
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "saklaz-vh-"));
  dirs.push(d);
  return d;
}
const zero = (b: Uint8Array | undefined) => !!b && b.length > 0 && b.every((x) => x === 0);
/** Çalışmayan (bitmiş) bir sürecin PID'i: gerçek bir çocuk süreç başlatılır ve bitmesi beklenir. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

describe("vault.lock", () => {
  it("aynı kasa ikinci kez açılamaz (aynı süreç dahil); kapanınca kilit kalkar", () => {
    const d = tmp();
    const p = join(d, "vault.bin");
    const a = new EncryptedFileVault(p, randomBytes(32), "personal");
    expect(existsSync(join(d, "vault.lock"))).toBe(true);
    const k2 = randomBytes(32);
    expect(() => new EncryptedFileVault(p, k2, "personal")).toThrow("VAULT_LOCKED");
    expect(zero(k2)).toBe(true); // reddedilen açılışın KEK'i sıfırlandı
    a.close();
    a.close(); // ikinci kapanış etkisiz
    expect(existsSync(join(d, "vault.lock"))).toBe(false);
    expect(() => a.get("x")).toThrow("VAULT_CLOSED");
    expect(() => {
      a.set("x", Uint8Array.of(1));
    }).toThrow("VAULT_CLOSED");
    expect(() => {
      a.delete("x");
    }).toThrow("VAULT_CLOSED");
    new EncryptedFileVault(p, randomBytes(32), "personal").close();
  });

  it("çöken sürecin kilidi (aynı makine, süreç yok) devralınır", () => {
    const d = tmp();
    const lock = join(d, "vault.lock");
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: hostname(), token: "eski", ts: 1 }));
    expect(VaultLock.isStale(lock)).toBe(true);
    const v = new EncryptedFileVault(join(d, "vault.bin"), randomBytes(32), "personal");
    expect((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid).toBe(process.pid);
    v.close();
    expect(existsSync(lock)).toBe(false);
  });

  it("sahibi çalışan, başka makineden gelen veya yeni yazılmış okunamayan kilit devralınmaz", () => {
    const d = tmp();
    const lock = join(d, "vault.lock");
    const p = join(d, "vault.bin");
    for (const content of [
      JSON.stringify({ pid: process.ppid, host: hostname(), token: "x", ts: 1 }), // canlı süreç
      JSON.stringify({ pid: deadPid(), host: "baska-makine", token: "x", ts: 1 }), // paylaşılan klasör
      "{yarım", // yazılırken çökmüş ama YENİ
    ]) {
      writeFileSync(lock, content);
      expect(() => new EncryptedFileVault(p, randomBytes(32), "personal")).toThrow("VAULT_LOCKED");
      expect(readFileSync(lock, "utf8")).toBe(content); // başkasının kilidine dokunulmadı
    }
    // okunamayan ama eski kilit → devralınır
    const old = (Date.now() - LOCK_UNREADABLE_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    new EncryptedFileVault(p, randomBytes(32), "personal").close();
    // şekli bozuk ama JSON olan, yeni kilit → kilitli
    writeFileSync(lock, JSON.stringify({ pid: "1" }));
    expect(() => new EncryptedFileVault(p, randomBytes(32), "personal")).toThrow("VAULT_LOCKED");
    utimesSync(lock, old, old);
    new EncryptedFileVault(p, randomBytes(32), "personal").close();
    // kilit klasörü bir dosyaysa → VAULT_LOCKED (EEXIST dışı hata)
    const file = join(d, "dosya");
    writeFileSync(file, "x");
    expect(() => VaultLock.acquire(join(file, "vault.lock"))).toThrow();
  });

  it("release yalnızca kendi kilidini siler (başkası devralmışsa dokunmaz)", () => {
    const d = tmp();
    const lock = join(d, "vault.lock");
    const l = VaultLock.acquire(lock);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "baskasi", ts: 1 }));
    l.release();
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    l.release(); // kilit yoksa sessiz
  });
});

describe("atomik yazım ve yazım hatası", () => {
  it("yazım başarısız olursa disk ve bellek eski değerde kalır, geçici dosya bırakılmaz", () => {
    const d = tmp();
    const p = join(d, "vault.bin");
    const kek = randomBytes(32);
    const v = new EncryptedFileVault(p, Uint8Array.from(kek), "personal");
    v.set("a", Uint8Array.of(1));
    const before = readFileSync(p);
    // vault.bin'in yerine boş olmayan bir klasör: yeniden adlandırma başarısız olur
    rmSync(p);
    mkdirSync(p);
    writeFileSync(join(p, "engel"), "x");
    expect(() => {
      v.set("a", Uint8Array.of(2));
    }).toThrow("VAULT_WRITE_FAILED");
    expect(() => {
      v.delete("a");
    }).toThrow("VAULT_WRITE_FAILED");
    expect(v.get("a")).toEqual(Uint8Array.of(1)); // bellek değişmedi
    expect(readdirSync(d).filter((f) => f.includes(".tmp-"))).toEqual([]); // geçici dosya temizlendi
    // engel kalkınca eski disk içeriği geri konur ve kasa yeniden yazılabilir
    rmSync(p, { recursive: true });
    writeFileSync(p, before);
    v.set("b", Uint8Array.of(3));
    v.close();
    const again = new EncryptedFileVault(p, Uint8Array.from(kek), "personal");
    expect(again.get("a")).toEqual(Uint8Array.of(1));
    expect(again.get("b")).toEqual(Uint8Array.of(3));
    again.close();
  });

  it("biçim değişmedi: SKV1 ‖ nonce(12) ‖ etiket(16) ‖ şifreli metin; eski dosya okunur", () => {
    const d = tmp();
    const p = join(d, "vault.bin");
    const kek = randomBytes(32);
    const v = new EncryptedFileVault(p, Uint8Array.from(kek), "personal");
    v.set("k", Uint8Array.of(5, 6));
    v.close();
    const f = readFileSync(p);
    expect(f.subarray(0, 4).toString()).toBe("SKV1");
    // aynı anahtarla bağımsız çözüm: biçim belgedeki gibi
    const dec = createDecipheriv("aes-256-gcm", kek, f.subarray(4, 16));
    dec.setAAD(Buffer.from("SAKLAZ-v1/vault|personal"));
    dec.setAuthTag(f.subarray(16, 32));
    const json = JSON.parse(Buffer.concat([dec.update(f.subarray(32)), dec.final()]).toString()) as Record<string, string>;
    expect(Buffer.from(json["k"] ?? "", "base64url")).toEqual(Buffer.from([5, 6]));
  });
});

describe("bellek temizliği", () => {
  it("çözme: düz metin tamponları (ara parçalar ve birleşik) sıfırlanır; get/set geçici kopyaları sıfırlanır", () => {
    const d = tmp();
    const p = join(d, "vault.bin");
    const kek = randomBytes(32);
    const v = new EncryptedFileVault(p, Uint8Array.from(kek), "personal");
    v.set("t", new TextEncoder().encode("token-degeri"));
    v.close();
    const concat = vi.spyOn(Buffer, "concat");
    const again = new EncryptedFileVault(p, Uint8Array.from(kek), "personal");
    const plainBufs = concat.mock.results.map((r) => r.value as Buffer);
    concat.mockRestore();
    expect(plainBufs.length).toBeGreaterThan(0);
    for (const b of plainBufs) expect(b.every((x) => x === 0)).toBe(true);
    // get: Buffer.from geçici kopyası
    const from = vi.spyOn(Buffer, "from");
    const got = again.get("t");
    const tmpBufs = from.mock.results.map((r) => r.value as Buffer);
    from.mockRestore();
    expect(new TextDecoder().decode(got)).toBe("token-degeri");
    for (const b of tmpBufs) expect(b.every((x) => x === 0)).toBe(true);
    // set: girdinin geçici kopyası sıfırlanır, çağıranın tamponuna dokunulmaz
    const input = new TextEncoder().encode("yeni");
    const from2 = vi.spyOn(Buffer, "from");
    again.set("t", input);
    const copies = from2.mock.results.map((r) => r.value as Buffer).filter((b) => b.length === input.length);
    from2.mockRestore();
    expect(copies.length).toBeGreaterThan(0);
    for (const b of copies) expect(b.every((x) => x === 0)).toBe(true);
    expect(new TextDecoder().decode(input)).toBe("yeni");
    again.close();
  });

  it("close() KEK'i sıfırlar; geçersiz uzunluklu KEK de sıfırlanır", () => {
    const d = tmp();
    const kek = randomBytes(32);
    const v = new EncryptedFileVault(join(d, "vault.bin"), kek, "personal");
    v.close();
    expect(zero(kek)).toBe(true);
    const short = randomBytes(16);
    expect(() => new EncryptedFileVault(join(d, "vault.bin"), short, "personal")).toThrow("VAULT_KEY");
    expect(zero(short)).toBe(true);
  });

  it("openVault kasa açılamazsa (bozuk dosya, kilit) KEK sıfırlanır ve kilit bırakılmaz", () => {
    const d = tmp();
    const ok = openVault(d, "personal", new FakeProtector());
    ok.vault.set("x", Uint8Array.of(1));
    ok.close();
    writeFileSync(join(d, "vault.bin"), Buffer.from("SKV1bozuk-bozuk-bozuk-bozuk-bozuk-bozuk"));
    const kekSpy = vi.spyOn(ProtectedKeyStore, "openOrCreate");
    expect(() => openVault(d, "personal", new FakeProtector())).toThrow("VAULT_CORRUPT");
    const kek = kekSpy.mock.results[0]?.value as { kek: Uint8Array } | undefined;
    expect(zero(kek?.kek)).toBe(true);
    expect(existsSync(join(d, "vault.lock"))).toBe(false);
    rmSync(join(d, "vault.bin"));
    const held = openVault(d, "personal", new FakeProtector());
    expect(() => openVault(d, "personal", new FakeProtector())).toThrow("VAULT_LOCKED");
    expect(zero((kekSpy.mock.results.at(-1)?.value as { kek: Uint8Array }).kek)).toBe(true);
    held.close();
  });

  it("servis: çekirdek açılamazsa kasa kapanır (kilit kalkar, KEK sıfırlanır)", () => {
    const d = tmp();
    mkdirSync(join(d, "agent.db")); // veritabanı yolu klasör → çekirdek açılamaz
    const kekSpy = vi.spyOn(ProtectedKeyStore, "openOrCreate");
    expect(() => new AgentService({ profile: "personal", dir: d, protector: new FakeProtector(), log: () => undefined })).toThrow();
    expect(zero((kekSpy.mock.results[0]?.value as { kek: Uint8Array }).kek)).toBe(true);
    expect(existsSync(join(d, "vault.lock"))).toBe(false);
  });

  it("servis: yenileme token'ı ve hesap kimliği bayt kopyaları kasaya yazıldıktan / okunduktan sonra sıfırlanır", async () => {
    const d = tmp();
    const svc = new AgentService({ profile: "personal", dir: d, protector: new FakeProtector(), log: () => undefined, allowInsecureRelay: true });
    svc.configure("ws://127.0.0.1:9", "PC");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          status: url.endsWith("/v1/devices") ? 201 : 200,
          json: () => Promise.resolve(url.endsWith("/login") ? { accessToken: "test-erisim", refreshToken: "test-yenileme-yer-tutucu", accountId: "acc" } : { ok: true }),
        }),
      ),
    );
    const setSpy = vi.spyOn(EncryptedFileVault.prototype, "set");
    const getSpy = vi.spyOn(EncryptedFileVault.prototype, "get");
    await svc.login("a@b.co", "parola", "123456");
    const written = setSpy.mock.calls.map((c) => c[1]);
    expect(written.length).toBe(2);
    for (const b of written) expect(zero(b)).toBe(true);
    expect(svc.isLoggedIn).toBe(true);
    const client = svc.connect();
    client.stop();
    const read = getSpy.mock.results.map((r) => r.value as Uint8Array | undefined).filter((b) => b !== undefined);
    expect(read.length).toBeGreaterThan(0);
    for (const b of read) expect(zero(b)).toBe(true);
    svc.close();
    // kasa hâlâ doğru değeri tutuyor (sıfırlanan yalnızca geçici kopyalar)
    const again = new AgentService({ profile: "personal", dir: d, protector: new FakeProtector(), log: () => undefined });
    expect(again.isLoggedIn).toBe(true);
    again.close();
  });
});

describe("eşleştirme komut satırı akışı", () => {
  it("servis açılamasa bile durdurulan arka plan görevi yeniden başlatılır", async () => {
    const calls: string[] = [];
    const task = {
      stop: () => {
        calls.push("stop");
        return true;
      },
      start: () => {
        calls.push("start");
      },
    };
    await expect(
      withBackgroundTaskPaused(task, () => {
        throw new VaultError("VAULT_LOCKED");
      }),
    ).rejects.toThrow("VAULT_LOCKED");
    expect(calls).toEqual(["stop", "start"]);
    expect(await withBackgroundTaskPaused(task, () => Promise.resolve(7))).toBe(7);
    // çalışmıyorduysa başlatılmaz
    const idle = { stop: () => false, start: vi.fn() };
    await withBackgroundTaskPaused(idle, () => Promise.resolve(0));
    expect(idle.start).not.toHaveBeenCalled();
  });

  function fakeSvc(dir: string, over: Partial<PairingService> = {}): PairingService {
    return {
      dir,
      config: {},
      isLoggedIn: true,
      connect: () => ({ waitReady: () => Promise.resolve() }),
      startPairing: () => "SAKLAZ1:test",
      waitForSas: () => Promise.resolve("123456"),
      confirmPairing: () => true,
      waitLinked: () => Promise.resolve(),
      ...over,
    };
  }
  function io(answer: string, seen: { svg: boolean }, dir: string): PairingIo {
    return {
      print: () => undefined,
      error: () => undefined,
      ask: () => {
        seen.svg = existsSync(join(dir, PAIRING_QR_FILE));
        return Promise.resolve(answer);
      },
      terminalQr: () => Promise.resolve("[qr]"),
      svgQr: () => Promise.resolve("<svg/>"),
    };
  }

  it("pairing-qr.svg başarı, ret, zaman aşımı ve hata durumlarında silinir", async () => {
    const d = tmp();
    const qr = join(d, PAIRING_QR_FILE);
    const seen = { svg: false };
    expect(await runPairing(fakeSvc(d), io("e", seen, d), "personal")).toBe(0);
    expect(seen.svg).toBe(true); // akış sırasında vardı
    expect(existsSync(qr)).toBe(false);

    expect(await runPairing(fakeSvc(d, { confirmPairing: () => false }), io("h", seen, d), "personal")).toBe(1);
    expect(existsSync(qr)).toBe(false);

    await expect(runPairing(fakeSvc(d, { waitForSas: () => Promise.reject(new Error("PAIRING_TIMEOUT")) }), io("e", seen, d), "personal")).rejects.toThrow("PAIRING_TIMEOUT");
    expect(existsSync(qr)).toBe(false);

    await expect(runPairing(fakeSvc(d, { waitLinked: () => Promise.reject(new Error("LINK_TIMEOUT")) }), io("e", seen, d), "personal")).rejects.toThrow("LINK_TIMEOUT");
    expect(existsSync(qr)).toBe(false);

    // kurulum yoksa hiç QR oluşturulmaz
    expect(await runPairing(fakeSvc(d, { isLoggedIn: false }), io("e", seen, d), "personal")).toBe(1);
    expect(existsSync(qr)).toBe(false);
  });
});
