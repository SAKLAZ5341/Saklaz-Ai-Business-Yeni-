/**
 * Relay yapılandırması ve gizli bilgilerin yüklenmesi (Sprint 3 A2).
 *
 * Kurallar:
 *   • Gizli bilgiler YALNIZCA dosyadan okunur (Docker/Podman secrets: /run/secrets/...). Ortam
 *     değişkeninde düz gizli değer bulunursa relay BAŞLAMAZ: ortam değişkenleri `docker inspect`,
 *     süreç listesi ve hata dökümlerinde görünür.
 *   • Hata mesajları gizli değeri, dosya içeriğini veya parolayı ASLA içermez; yalnızca hangi
 *     ayarın sorunlu olduğunu söyler.
 *   • Her şey açılışta doğrulanır; eksik veya hatalı bir ayarla yarım çalışan bir relay olmaz.
 */
import { readFileSync } from "node:fs";

export type ConfigErrorCode =
  | "SECRET_IN_ENV"
  | "SECRET_FILE_MISSING"
  | "SECRET_FILE_UNREADABLE"
  | "SECRET_EMPTY"
  | "MFA_KEY_INVALID"
  | "DB_CONFIG_MISSING"
  | "DB_CONFIG_AMBIGUOUS"
  | "RELAY_ID_INVALID"
  | "SETTING_INVALID";

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    /** Yalnızca ayarın ADI ve kısa açıklama; gizli değer içermez. */
    readonly setting: string,
  ) {
    super(`${code}: ${setting}`);
    this.name = "ConfigError";
  }
}

export type MigrateMode = "apply" | "check";

export interface RelayConfig {
  relayId: string;
  host: string;
  port: number;
  /** Önündeki ters vekil sayısı (Caddy: 1). 0 ise X-Forwarded-For dikkate alınmaz. */
  trustProxyHops: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug";
  migrateMode: MigrateMode;
  /** Açılışta veritabanını bekleme süresi (ms). */
  dbWaitMs: number;
  secrets: {
    databaseUrl: string;
    jwtPrivatePem: string;
    jwtPublicPem: string;
    mfaKey: Uint8Array;
  };
}

/** Bu adlarla ortam değişkeni tanımlıysa relay başlamaz (gizli değer ortamda olmamalı). */
export const FORBIDDEN_SECRET_ENV = [
  "SAKLAZ_DATABASE_URL",
  "SAKLAZ_DB_PASSWORD",
  "SAKLAZ_JWT_PRIVATE_KEY",
  "SAKLAZ_JWT_PUBLIC_KEY",
  "SAKLAZ_MFA_KEY",
  "DATABASE_URL",
  "PGPASSWORD",
] as const;

type Env = Readonly<Record<string, string | undefined>>;
type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (p) => readFileSync(p, "utf8");

function readSecret(env: Env, name: string, read: ReadFile): string {
  const path = env[name];
  if (!path) throw new ConfigError("SECRET_FILE_MISSING", name);
  let raw: string;
  try {
    raw = read(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new ConfigError(code === "ENOENT" ? "SECRET_FILE_MISSING" : "SECRET_FILE_UNREADABLE", name);
  }
  const v = raw.trim();
  if (v.length === 0) throw new ConfigError("SECRET_EMPTY", name);
  return v;
}

function intSetting(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError("SETTING_INVALID", name);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError("SETTING_INVALID", name);
  return n;
}

function databaseUrl(env: Env, read: ReadFile): string {
  const hasUrl = !!env["SAKLAZ_DATABASE_URL_FILE"];
  const hasParts = !!env["SAKLAZ_DB_PASSWORD_FILE"];
  if (hasUrl && hasParts) throw new ConfigError("DB_CONFIG_AMBIGUOUS", "SAKLAZ_DATABASE_URL_FILE / SAKLAZ_DB_PASSWORD_FILE");
  if (hasUrl) return readSecret(env, "SAKLAZ_DATABASE_URL_FILE", read);
  if (!hasParts) throw new ConfigError("DB_CONFIG_MISSING", "SAKLAZ_DATABASE_URL_FILE veya SAKLAZ_DB_PASSWORD_FILE");
  // Parça parça yapılandırma: parola, veritabanı konteyneriyle AYNI gizli dosyadan okunur;
  // böylece parola iki ayrı yerde tutulmaz. Sunucu, kullanıcı ve veritabanı adı gizli değildir.
  const password = readSecret(env, "SAKLAZ_DB_PASSWORD_FILE", read);
  const host = env["SAKLAZ_DB_HOST"] ?? "db";
  const port = intSetting(env, "SAKLAZ_DB_PORT", 5432, 1, 65535);
  const user = env["SAKLAZ_DB_USER"] ?? "saklaz";
  const name = env["SAKLAZ_DB_NAME"] ?? "saklaz";
  for (const [k, v] of [["SAKLAZ_DB_HOST", host], ["SAKLAZ_DB_USER", user], ["SAKLAZ_DB_NAME", name]] as const) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(v)) throw new ConfigError("SETTING_INVALID", k);
  }
  const u = new URL("postgresql://placeholder");
  u.hostname = host;
  u.port = String(port);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  u.pathname = `/${name}`;
  return u.toString();
}

export function loadConfig(env: Env = process.env, read: ReadFile = defaultRead): RelayConfig {
  for (const k of FORBIDDEN_SECRET_ENV) {
    if (env[k] !== undefined) throw new ConfigError("SECRET_IN_ENV", k);
  }

  const relayId = env["SAKLAZ_RELAY_ID"] ?? "";
  // Çalışma alanına özgü kimlik (ör. "saklaz-personal", "saklaz-business"). JWT "iss" alanı ve
  // relay kimlik doğrulama imzası bu değere bağlıdır; iki kurulumun token'ları birbirinde geçmez.
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(relayId)) throw new ConfigError("RELAY_ID_INVALID", "SAKLAZ_RELAY_ID");

  const level = env["SAKLAZ_LOG_LEVEL"] ?? "info";
  if (!["fatal", "error", "warn", "info", "debug"].includes(level)) throw new ConfigError("SETTING_INVALID", "SAKLAZ_LOG_LEVEL");
  const mode = env["SAKLAZ_MIGRATE"] ?? "apply";
  if (mode !== "apply" && mode !== "check") throw new ConfigError("SETTING_INVALID", "SAKLAZ_MIGRATE");
  const host = env["SAKLAZ_LISTEN_HOST"] ?? "0.0.0.0";
  if (!/^[0-9a-fA-F.:]{2,45}$/.test(host)) throw new ConfigError("SETTING_INVALID", "SAKLAZ_LISTEN_HOST");

  const mfaHex = readSecret(env, "SAKLAZ_MFA_KEY_FILE", read);
  if (!/^[0-9a-fA-F]{64}$/.test(mfaHex)) throw new ConfigError("MFA_KEY_INVALID", "SAKLAZ_MFA_KEY_FILE (64 hex karakter = 32 bayt olmalı)");

  return {
    relayId,
    host,
    port: intSetting(env, "SAKLAZ_PORT", 8080, 0, 65535), // 0: işletim sistemi seçer (testler)
    trustProxyHops: intSetting(env, "SAKLAZ_TRUST_PROXY_HOPS", 0, 0, 5),
    logLevel: level as RelayConfig["logLevel"],
    migrateMode: mode,
    dbWaitMs: intSetting(env, "SAKLAZ_DB_WAIT_MS", 60_000, 0, 600_000),
    secrets: {
      databaseUrl: databaseUrl(env, read),
      jwtPrivatePem: readSecret(env, "SAKLAZ_JWT_PRIVATE_KEY_FILE", read),
      jwtPublicPem: readSecret(env, "SAKLAZ_JWT_PUBLIC_KEY_FILE", read),
      mfaKey: Uint8Array.from(Buffer.from(mfaHex, "hex")),
    },
  };
}
