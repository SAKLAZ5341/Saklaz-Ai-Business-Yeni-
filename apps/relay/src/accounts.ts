/**
 * Hesaplar ve oturum: Argon2id parola, zorunlu TOTP, kısa ömürlü erişim token'ı (EdDSA JWT),
 * dönen tek kullanımlık yenileme token'ı (yeniden kullanım tespit edilirse token ailesi iptal edilir),
 * kaba kuvvet kilidi.
 *
 * Önemli: Bu katman yalnızca relay'e BAĞLANMA yetkisi verir. Ajana komut yetkisi vermez
 * (komutlar telefonun cihaz anahtarıyla imzalıdır).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { SignJWT, jwtVerify, type CryptoKey, type KeyObject } from "jose";
import { auditMeta, type Pool } from "./db.js";
import { generateTotpSecret, matchTotpStep, otpauthUri } from "./totp.js";

export class AuthError extends Error {
  constructor(readonly code: "INVALID_CREDENTIALS" | "LOCKED" | "MFA_REQUIRED" | "MFA_INVALID" | "TOKEN_INVALID" | "TOKEN_REUSED" | "EMAIL_TAKEN" | "WEAK_PASSWORD") {
    super(code);
    this.name = "AuthError";
  }
}

export interface AccountsConfig {
  jwtPrivateKey: CryptoKey | KeyObject;
  jwtPublicKey: CryptoKey | KeyObject;
  /** MFA sırlarını şifreleyen 32 baytlık anahtar (veritabanı dışında, gizli dosyada). */
  mfaKey: Uint8Array;
  issuer: string;
  now?: () => number;
  accessTtlSec?: number;
  refreshTtlSec?: number;
  maxFailures?: number;
  lockMinutes?: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

function encryptSecret(key: Uint8Array, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function decryptSecret(key: Uint8Array, blob: Buffer): Uint8Array {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

/** Açılış denetimi için: verilen anahtar bu şifreli TOTP sırrını çözebiliyor mu? (AES-GCM etiketi doğrulanır.) */
export function canDecryptSecret(key: Uint8Array, blob: Buffer): boolean {
  try {
    decryptSecret(key, blob);
    return true;
  } catch {
    return false;
  }
}

export class Accounts {
  private readonly now: () => number;
  constructor(
    private readonly pool: Pool,
    private readonly cfg: AccountsConfig,
  ) {
    this.now = cfg.now ?? Date.now;
  }

  /** Hesap oluşturur; TOTP kurulum adresini YALNIZCA BİR KEZ döndürür. MFA, ilk doğrulamayla etkinleşir. */
  async register(email: string, password: string): Promise<{ accountId: string; otpauth: string }> {
    if (password.length < 12) throw new AuthError("WEAK_PASSWORD");
    const id = randomUUID();
    const secret = generateTotpSecret();
    const ph = await argonHash(password); // Argon2id varsayılanları (m=19 MiB, t=2, p=1 — OWASP asgari)
    try {
      await this.pool.query("INSERT INTO accounts (id, email, password_hash, totp_secret_enc) VALUES ($1, $2, $3, $4)", [
        id,
        email,
        ph,
        encryptSecret(this.cfg.mfaKey, secret),
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AuthError("EMAIL_TAKEN");
      throw e;
    }
    await auditMeta(this.pool, { accountId: id, actor: "account", action: "account.registered", details: {} });
    return { accountId: id, otpauth: otpauthUri(secret, email) };
  }

  /** Parola + TOTP ile giriş. MFA henüz etkin değilse ilk geçerli kod onu etkinleştirir. */
  async login(email: string, password: string, code: string): Promise<{ accessToken: string; refreshToken: string; accountId: string }> {
    const r = await this.pool.query<{ id: string; password_hash: string; totp_secret_enc: Buffer; failed_logins: number; locked_until: Date | null }>(
      "SELECT id, password_hash, totp_secret_enc, failed_logins, locked_until FROM accounts WHERE lower(email) = lower($1)",
      [email],
    );
    const a = r.rows[0];
    if (!a) {
      await argonHash(password); // zamanlama farkıyla hesap varlığını sızdırmamak için
      throw new AuthError("INVALID_CREDENTIALS");
    }
    if (a.locked_until && a.locked_until.getTime() > this.now()) throw new AuthError("LOCKED");
    const pwOk = await argonVerify(a.password_hash, password);
    const step = pwOk ? matchTotpStep(decryptSecret(this.cfg.mfaKey, a.totp_secret_enc), code, this.now()) : undefined;

    // TOTP tekrar kullanım koruması (Sprint 3 A1): kodun adımı, bu hesapta daha önce tüketilmiş
    // adımdan BÜYÜKSE kabul edilir. Karşılaştırma ve tüketme tek bir koşullu UPDATE'tir; PostgreSQL
    // satır kilidi sayesinde aynı kodla gelen eşzamanlı isteklerden en fazla biri başarılı olur.
    // Değer veritabanında olduğu için koruma yeniden başlatmadan sonra da sürer.
    let replay = false;
    if (step !== undefined) {
      const consumed = await this.pool.query(
        `UPDATE accounts SET totp_last_step = $2, failed_logins = 0, locked_until = NULL, mfa_enabled = true
          WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
        [a.id, step.toString()],
      );
      if (consumed.rowCount === 1) {
        await auditMeta(this.pool, { accountId: a.id, actor: "account", action: "login.ok", details: {} });
        const family = randomUUID();
        return { accountId: a.id, accessToken: await this.issueAccess(a.id), refreshToken: await this.issueRefresh(a.id, family) };
      }
      replay = true;
    }

    // Başarısız deneme (yanlış parola, yanlış kod veya tekrar kullanılan kod). Sayaç atomik artırılır;
    // eşzamanlı başarısız denemeler kaybolmaz. Eşik aşılırsa hesap kilitlenir ve sayaç sıfırlanır.
    const max = this.cfg.maxFailures ?? 10;
    const lockUntil = new Date(this.now() + (this.cfg.lockMinutes ?? 15) * 60_000);
    const f = await this.pool.query<{ locked: boolean }>(
      `UPDATE accounts
          SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
              locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN $3 ELSE locked_until END
        WHERE id = $1
        RETURNING (failed_logins = 0 AND locked_until = $3) AS locked`,
      [a.id, max, lockUntil],
    );
    const locked = f.rows[0]?.locked === true;
    const action = locked ? "login.locked" : replay ? "login.totp_replay" : "login.failed";
    await auditMeta(this.pool, { accountId: a.id, actor: "account", action, details: { mfa: pwOk, replay } });
    // İstemciye tekrar kullanım ile yanlış kod arasında fark gösterilmez (sunucu tarafında MFA_INVALID → INVALID_CREDENTIALS).
    throw new AuthError(pwOk ? "MFA_INVALID" : "INVALID_CREDENTIALS");
  }

  /** Testler ve yönetim için: hesabın tüketilmiş en yüksek TOTP adımı. */
  async totpLastStep(accountId: string): Promise<bigint | undefined> {
    const r = await this.pool.query<{ s: string | null }>("SELECT totp_last_step::text AS s FROM accounts WHERE id = $1", [accountId]);
    const s = r.rows[0]?.s;
    return s == null ? undefined : BigInt(s);
  }

  private async issueAccess(accountId: string): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(accountId)
      .setIssuer(this.cfg.issuer)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + (this.cfg.accessTtlSec ?? 600))
      .setJti(randomUUID())
      .sign(this.cfg.jwtPrivateKey);
  }

  private async issueRefresh(accountId: string, family: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO refresh_tokens (id, account_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), accountId, family, sha256(token), new Date(this.now() + (this.cfg.refreshTtlSec ?? 30 * 86400) * 1000)],
    );
    return token;
  }

  /** Tek kullanımlık yenileme. Kullanılmış bir token tekrar gelirse tüm aile iptal edilir (çalıntı tespiti). */
  async refresh(token: string): Promise<{ accessToken: string; refreshToken: string }> {
    const r = await this.pool.query<{ id: string; account_id: string; family_id: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }>(
      "SELECT id, account_id, family_id, expires_at, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1",
      [sha256(token)],
    );
    const t = r.rows[0];
    if (!t || t.revoked_at || t.expires_at.getTime() < this.now()) throw new AuthError("TOKEN_INVALID");
    if (t.used_at) {
      await this.pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1", [t.family_id]);
      await auditMeta(this.pool, { accountId: t.account_id, actor: "account", action: "refresh.reuse_detected", details: {} });
      throw new AuthError("TOKEN_REUSED");
    }
    await this.pool.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [t.id]);
    return { accessToken: await this.issueAccess(t.account_id), refreshToken: await this.issueRefresh(t.account_id, t.family_id) };
  }

  async verifyAccess(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.cfg.jwtPublicKey, {
        issuer: this.cfg.issuer,
        algorithms: ["EdDSA"],
        currentDate: new Date(this.now()),
      });
      if (!payload.sub) throw new AuthError("TOKEN_INVALID");
      return payload.sub;
    } catch {
      throw new AuthError("TOKEN_INVALID");
    }
  }
}
