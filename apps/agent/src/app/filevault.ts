/**
 * Şifreli dosya kasası (MVP alfa). Kasa değerleri tek dosyada (vault.bin), DPAPI ile korunan 32 baytlık
 * KEK altında AES-256-GCM ile şifrelenir. KEK, ProtectedKeyStore'dan (kullanıcı profiline bağlı) gelir.
 *
 *   dosya: "SKV1" ‖ nonce(12) ‖ etiket(16) ‖ şifreli JSON;  AAD = "SAKLAZ-v1/vault|" ‖ profil
 *
 * Yazım atomiktir (geçici dosya + fsync + yeniden adlandırma). Bozuk veya başka anahtarla
 * şifrelenmiş dosya açılmaz (VAULT_CORRUPT); kasa dosyası hiçbir zaman sessizce sıfırlanmaz.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretVault } from "../vault.js";

const MAGIC = Buffer.from("SKV1");

export class VaultError extends Error {
  constructor(readonly code: "VAULT_CORRUPT" | "VAULT_KEY") {
    super(code);
    this.name = "VaultError";
  }
}

export class EncryptedFileVault implements SecretVault {
  readonly kind = "dpapi" as const;
  private data: Record<string, string>;
  private readonly aad: Buffer;

  constructor(
    private readonly path: string,
    private readonly kek: Uint8Array,
    profile: string,
  ) {
    if (kek.length !== 32) throw new VaultError("VAULT_KEY");
    this.aad = Buffer.from(`SAKLAZ-v1/vault|${profile}`, "utf8");
    this.data = existsSync(path) ? this.decrypt(readFileSync(path)) : {};
  }

  private decrypt(file: Buffer): Record<string, string> {
    if (file.length < 4 + 12 + 16 || !file.subarray(0, 4).equals(MAGIC)) throw new VaultError("VAULT_CORRUPT");
    try {
      const d = createDecipheriv("aes-256-gcm", this.kek, file.subarray(4, 16));
      d.setAAD(this.aad);
      d.setAuthTag(file.subarray(16, 32));
      const plain = Buffer.concat([d.update(file.subarray(32)), d.final()]);
      const o = JSON.parse(plain.toString("utf8")) as unknown;
      plain.fill(0);
      if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("şekil");
      return o as Record<string, string>;
    } catch {
      throw new VaultError("VAULT_CORRUPT");
    }
  }

  get(name: string): Uint8Array | undefined {
    const v = this.data[name];
    return v === undefined ? undefined : Uint8Array.from(Buffer.from(v, "base64url"));
  }

  set(name: string, value: Uint8Array): void {
    this.data = { ...this.data, [name]: Buffer.from(value).toString("base64url") };
    this.flush();
  }

  delete(name: string): void {
    if (!(name in this.data)) return;
    const rest = { ...this.data };
    Reflect.deleteProperty(rest, name);
    this.data = rest;
    this.flush();
  }

  private flush(): void {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, nonce);
    c.setAAD(this.aad);
    const plain = Buffer.from(JSON.stringify(this.data), "utf8");
    const ct = Buffer.concat([c.update(plain), c.final()]);
    plain.fill(0);
    const out = Buffer.concat([MAGIC, nonce, c.getAuthTag(), ct]);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid.toString()}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, out);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
