/**
 * Şifreli dosya kasası (MVP alfa). Kasa değerleri tek dosyada (vault.bin), DPAPI ile korunan 32 baytlık
 * KEK altında AES-256-GCM ile şifrelenir. KEK, ProtectedKeyStore'dan (kullanıcı profiline bağlı) gelir.
 *
 *   dosya: "SKV1" ‖ nonce(12) ‖ etiket(16) ‖ şifreli JSON;  AAD = "SAKLAZ-v1/vault|" ‖ profil
 *
 * Biçim notu: A3 teknik tasarımındaki tam kasa v2 (`vault.bin` v2) XChaCha20-Poly1305 öngörür. Bu MVP
 * dosyası (SKV1) AES-256-GCM kullanır ve biçimi DEĞİŞTİRİLMEMİŞTİR (geriye dönük uyumluluk). İki biçim
 * arasındaki geçiş, sürüm alanıyla tek seferde ve iki yönlü sınanarak v2 diliminde yapılacaktır.
 * AES-GCM'de rastgele 96 bit nonce kullanılır; kasa yazım sayısı düşük olduğundan (oturum başına birkaç)
 * aynı anahtarla nonce çakışma olasılığı ihmal edilebilir düzeydedir.
 *
 * Eşzamanlılık: kasa açıkken `vault.lock` dosyası tutulur (yalnızca bir süreç; aynı süreçte ikinci örnek
 * de reddedilir). Kilidi tutan süreç çökerse (aynı makinede, süreç artık yok) kilit eski sayılır ve
 * devralınır. Başka makineden gelen veya sahibi hâlâ çalışan kilit devralınmaz (VAULT_LOCKED).
 *
 * Yazım: benzersiz geçici dosya + fsync + yeniden adlandırma. Yazım başarısız olursa geçici dosya silinir,
 * diskteki kasa ve bellekteki değerler değişmeden kalır (VAULT_WRITE_FAILED).
 *
 * Bellek: düz metin tamponlar (çözülmüş JSON, geçici kopyalar) kullanım sonrası sıfırlanır. JavaScript
 * dizgeleri (JSON metni, base64 değerler) değiştirilemez olduğundan sıfırlanamaz; bu bilinen bir sınırdır.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { SecretVault } from "../vault.js";

const MAGIC = Buffer.from("SKV1");
/** Okunamayan/yarım kalmış kilit dosyası bu süreden eskiyse eski sayılır (sahibi yazarken çökmüş). */
export const LOCK_UNREADABLE_STALE_MS = 30_000;

export type VaultErrorCode = "VAULT_CORRUPT" | "VAULT_KEY" | "VAULT_LOCKED" | "VAULT_WRITE_FAILED" | "VAULT_CLOSED";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

interface LockInfo {
  pid: number;
  host: string;
  token: string;
  ts: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: süreç var ama sinyal izni yok → canlı say (güvenli yön).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kasa kilidi. Dışa açık yalnızca testler içindir. */
export class VaultLock {
  private constructor(
    readonly path: string,
    private readonly token: string,
  ) {}

  static acquire(path: string, now: () => number = Date.now): VaultLock {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const info: LockInfo = { pid: process.pid, host: hostname(), token: randomBytes(16).toString("hex"), ts: now() };
      let fd: number;
      try {
        fd = openSync(path, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new VaultError("VAULT_LOCKED");
        if (attempt === 0 && VaultLock.isStale(path, now)) {
          try {
            unlinkSync(path);
          } catch {
            /* başka biri aynı anda devraldı; ikinci denemede EEXIST → kilitli */
          }
          continue;
        }
        throw new VaultError("VAULT_LOCKED");
      }
      try {
        writeSync(fd, JSON.stringify(info));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return new VaultLock(path, info.token);
    }
    throw new VaultError("VAULT_LOCKED");
  }

  /** Eski kilit: aynı makinede ve sahibi süreç artık yok; ya da okunamıyor ve yeterince eski. */
  static isStale(path: string, now: () => number = Date.now): boolean {
    let info: Partial<LockInfo>;
    try {
      info = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    } catch {
      try {
        return now() - statSync(path).mtimeMs > LOCK_UNREADABLE_STALE_MS;
      } catch {
        return true; // dosya artık yok
      }
    }
    if (typeof info.pid !== "number" || typeof info.host !== "string") {
      try {
        return now() - statSync(path).mtimeMs > LOCK_UNREADABLE_STALE_MS;
      } catch {
        return true;
      }
    }
    if (info.host !== hostname()) return false; // başka makinenin kilidi (paylaşılan klasör): devralınmaz
    if (info.pid === process.pid) return false; // bu süreçte zaten açık
    return !processAlive(info.pid);
  }

  /** Yalnızca kilit hâlâ bizimse siler (başkası devralmışsa dokunmaz). */
  release(): void {
    try {
      const info = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockInfo>;
      if (info.token === this.token) unlinkSync(this.path);
    } catch {
      /* kilit yok veya okunamıyor: dokunma */
    }
  }
}

export class EncryptedFileVault implements SecretVault {
  readonly kind = "dpapi" as const;
  private data: Record<string, string>;
  private readonly aad: Buffer;
  private readonly lock: VaultLock;
  private closed = false;

  /**
   * @param kek  Kasa bu tamponu kullanır ve close() ile SIFIRLAR (sahiplik kasaya geçer). Kurucu hata
   *             fırlatırsa da sıfırlanır.
   */
  constructor(
    private readonly path: string,
    private readonly kek: Uint8Array,
    profile: string,
  ) {
    if (kek.length !== 32) {
      kek.fill(0);
      throw new VaultError("VAULT_KEY");
    }
    this.aad = Buffer.from(`SAKLAZ-v1/vault|${profile}`, "utf8");
    try {
      this.lock = VaultLock.acquire(join(dirname(path), "vault.lock"));
    } catch (e) {
      kek.fill(0);
      throw e;
    }
    try {
      this.data = existsSync(path) ? this.decrypt(readFileSync(path)) : {};
    } catch (e) {
      this.lock.release();
      kek.fill(0);
      throw e;
    }
  }

  private decrypt(file: Buffer): Record<string, string> {
    if (file.length < 4 + 12 + 16 || !file.subarray(0, 4).equals(MAGIC)) throw new VaultError("VAULT_CORRUPT");
    const parts: Buffer[] = [];
    let plain: Buffer | undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.kek, file.subarray(4, 16));
      d.setAAD(this.aad);
      d.setAuthTag(file.subarray(16, 32));
      parts.push(d.update(file.subarray(32)));
      parts.push(d.final());
      plain = Buffer.concat(parts);
      const o = JSON.parse(plain.toString("utf8")) as unknown;
      if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("şekil");
      return o as Record<string, string>;
    } catch {
      throw new VaultError("VAULT_CORRUPT");
    } finally {
      for (const p of parts) p.fill(0);
      plain?.fill(0);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new VaultError("VAULT_CLOSED");
  }

  get(name: string): Uint8Array | undefined {
    this.ensureOpen();
    const v = this.data[name];
    if (v === undefined) return undefined;
    const tmp = Buffer.from(v, "base64url");
    try {
      return Uint8Array.from(tmp);
    } finally {
      tmp.fill(0);
    }
  }

  set(name: string, value: Uint8Array): void {
    this.ensureOpen();
    const tmp = Buffer.from(value);
    let encoded: string;
    try {
      encoded = tmp.toString("base64url");
    } finally {
      tmp.fill(0);
    }
    const next = { ...this.data, [name]: encoded };
    this.flush(next);
    this.data = next; // yalnızca disk yazımı başarılıysa
  }

  delete(name: string): void {
    this.ensureOpen();
    if (!(name in this.data)) return;
    const next = { ...this.data };
    Reflect.deleteProperty(next, name);
    this.flush(next);
    this.data = next;
  }

  private flush(next: Record<string, string>): void {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, nonce);
    c.setAAD(this.aad);
    const plain = Buffer.from(JSON.stringify(next), "utf8");
    let ct: Buffer;
    try {
      ct = Buffer.concat([c.update(plain), c.final()]);
    } finally {
      plain.fill(0);
    }
    const out = Buffer.concat([MAGIC, nonce, c.getAuthTag(), ct]); // biçim değişmedi (SKV1)
    const tmp = `${this.path}.tmp-${process.pid.toString()}-${randomBytes(6).toString("hex")}`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, out);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* zaten kapalı */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* oluşmamış olabilir */
      }
      throw new VaultError("VAULT_WRITE_FAILED");
    }
    syncDir(dirname(this.path));
  }

  /** Kilidi bırakır ve KEK'i sıfırlar. İkinci çağrı etkisizdir. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.data = {};
    this.kek.fill(0);
    this.lock.release();
  }
}

/** Yeniden adlandırmanın kalıcı olması için klasörü eşitler (POSIX). Windows'ta klasör açılamaz; atlanır. */
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* desteklenmiyor */
  }
}
