/**
 * Kullanıcı profiline bağlı korumalı anahtar dosyası (Sprint 3 A3; teknik tasarım §5–§8, §10).
 *
 * 32 baytlık KEK yalnızca KeyProtector (Windows'ta DPAPI) ile SARILMIŞ olarak diske yazılır;
 * düz metin hiçbir yolda diske, günlüğe veya hata nesnesine girmez.
 *
 * Dosya biçimi "SKK1" (bütün tamsayılar büyük uçlu):
 *   0   4   magic        "SKK1"
 *   4   2   sürüm        1
 *   6   1   koruyucu     1 = dpapi-user, 0xF0 = test-fake
 *   7   1   bayraklar    0 (ayrılmış)
 *   8   16  keyId        rastgele, oluşturulurken bir kez
 *   24  32  bindingHash  BLAKE2b("SAKLAZ-v1/kek-binding", SID ‖ MachineGuid) — gizli değil
 *   56  4   wrappedLen   1..4096
 *   60  N   wrapped      koruyucunun blob'u
 *
 * Bağlama iki katmanlıdır:
 *   1. bindingHash, açılışta geçerli kullanıcı ve makineyle karşılaştırılır → BINDING_MISMATCH
 *      (ör. dolaşan profille dosyanın başka bir makinede açılması).
 *   2. Koruyucuya verilen entropy, başlığın tamamının özetidir: başlıktaki herhangi bir bayt
 *      değişirse DPAPI çözmeyi reddeder.
 *
 * Kayıt: yeni dosya geçici dosyaya yazılır, diske zorlanır, sonra sabit bağlantıyla (hard link)
 * hedef ada bağlanır. Bağlama, hedef varsa BAŞARISIZ olur: var olan anahtar dosyasının üzerine
 * HİÇBİR ZAMAN yazılmaz (anahtar kaybı = kasanın kaybı).
 */
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync, mkdirSync, existsSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { concat, equalConstantTime, randomBytes, taggedHash, utf8, wipe } from "@saklaz/crypto";
import { KeyProtectionError, PROTECTOR_IDS, type KeyProtector, type ProtectorBinding } from "./protectors/types.js";

export const KEK_BYTES = 32;
const MAGIC = utf8("SKK1");
const VERSION = 1;
const HEADER_FIXED = 60;
const MAX_WRAPPED = 4096;

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}

/** Bağlam özeti: SID ve MachineGuid uzunluk önekli birleştirilir (belirsizlik olmasın). */
export function bindingHash(b: ProtectorBinding): Uint8Array {
  const sid = utf8(b.userSid);
  const guid = utf8(b.machineGuid.toLowerCase());
  return taggedHash("SAKLAZ-v1/kek-binding", concat(u16(sid.length), sid, u16(guid.length), guid), 32);
}

function entropyFor(header56: Uint8Array): Uint8Array {
  return taggedHash("SAKLAZ-v1/kek-entropy", header56, 32);
}

function buildHeader(protector: KeyProtector, keyId: Uint8Array): Uint8Array {
  const h = new Uint8Array(56);
  h.set(MAGIC, 0);
  h.set(u16(VERSION), 4);
  h[6] = PROTECTOR_IDS[protector.kind];
  h[7] = 0;
  h.set(keyId, 8);
  h.set(bindingHash(protector.binding()), 24);
  return h;
}

/** Dosyayı yalnızca yapısal olarak ayrıştırır; hiçbir şeyi çözmez. */
function parse(file: Uint8Array): { header56: Uint8Array; kind: number; wrapped: Uint8Array; bHash: Uint8Array } {
  if (file.length < HEADER_FIXED + 1 || !equalConstantTime(file.subarray(0, 4), MAGIC)) throw new KeyProtectionError("KEY_FORMAT");
  const version = ((file[4] ?? 0) << 8) | (file[5] ?? 0);
  if (version !== VERSION) throw new KeyProtectionError("KEY_VERSION");
  if (file[7] !== 0) throw new KeyProtectionError("KEY_FORMAT");
  const len = new DataView(file.buffer, file.byteOffset + 56, 4).getUint32(0, false);
  if (len < 1 || len > MAX_WRAPPED || file.length !== HEADER_FIXED + len) throw new KeyProtectionError("KEY_FORMAT");
  return { header56: file.subarray(0, 56), kind: file[6] ?? 0, wrapped: file.subarray(60, 60 + len), bHash: file.subarray(24, 56) };
}

/** Geçici dosyaya yaz, diske zorla, hedef ada bağla (hedef varsa başarısız), geçiciyi sil. */
function writeNew(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid.toString()}-${Buffer.from(randomBytes(6)).toString("hex")}`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") throw new KeyProtectionError("KEY_EXISTS");
      throw new KeyProtectionError("WRITE_FAILED");
    }
  } catch (e) {
    if (e instanceof KeyProtectionError) throw e;
    throw new KeyProtectionError("WRITE_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // geçici dosya oluşmadıysa silinecek bir şey yok
    }
  }
}

export const ProtectedKeyStore = {
  /**
   * Yeni bir KEK üretir, koruyucuyla sarar ve dosyaya yazar. Dosya zaten varsa KEY_EXISTS
   * (üzerine yazılmaz). Dönen KEK'i çağıran, işi bitince wipe() ile silmelidir.
   */
  create(path: string, protector: KeyProtector): Uint8Array {
    if (existsSync(path)) throw new KeyProtectionError("KEY_EXISTS");
    const header = buildHeader(protector, randomBytes(16));
    const kek = randomBytes(KEK_BYTES);
    const wrapped = protector.wrap(kek, entropyFor(header));
    if (wrapped.length < 1 || wrapped.length > MAX_WRAPPED) {
      wipe(kek);
      throw new KeyProtectionError("PROTECT_FAILED");
    }
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, wrapped.length, false);
    try {
      writeNew(path, concat(header, len, wrapped));
    } catch (e) {
      wipe(kek);
      throw e;
    }
    return kek;
  },

  /**
   * Var olan KEK'i çözer. Dosya değiştirilmez veya silinmez (bozuk olsa bile; inceleme için).
   * Hatalar: KEY_NOT_FOUND, KEY_FORMAT, KEY_VERSION, PROTECTOR_MISMATCH, BINDING_MISMATCH, UNWRAP_FAILED.
   */
  load(path: string, protector: KeyProtector): Uint8Array {
    let file: Uint8Array;
    try {
      file = new Uint8Array(readFileSync(path));
    } catch (e) {
      throw new KeyProtectionError((e as { code?: string }).code === "ENOENT" ? "KEY_NOT_FOUND" : "KEY_FORMAT");
    }
    if (file.length > HEADER_FIXED + MAX_WRAPPED) throw new KeyProtectionError("KEY_FORMAT");
    const p = parse(file);
    if (p.kind !== PROTECTOR_IDS[protector.kind]) throw new KeyProtectionError("PROTECTOR_MISMATCH");
    if (!equalConstantTime(p.bHash, bindingHash(protector.binding()))) throw new KeyProtectionError("BINDING_MISMATCH");
    const kek = protector.unwrap(p.wrapped, entropyFor(p.header56));
    if (kek.length !== KEK_BYTES) {
      wipe(kek);
      throw new KeyProtectionError("KEY_FORMAT");
    }
    return kek;
  },

  /** Varsa açar, yoksa oluşturur. */
  openOrCreate(path: string, protector: KeyProtector): { kek: Uint8Array; created: boolean } {
    if (!existsSync(path)) {
      try {
        return { kek: ProtectedKeyStore.create(path, protector), created: true };
      } catch (e) {
        // Aynı anda başka bir süreç oluşturduysa onunkini aç.
        if (!(e instanceof KeyProtectionError && e.code === "KEY_EXISTS")) throw e;
      }
    }
    return { kek: ProtectedKeyStore.load(path, protector), created: false };
  },
};

/**
 * Kullanıcı profiline bağlı varsayılan konum: %LOCALAPPDATA%\SAKLAZ\<çalışma alanı>\kek.bin
 * Local seçilir, Roaming değil: dosya dolaşan profille başka makineye taşınmaz.
 */
export function defaultKeyPath(workspaceId: string, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") throw new KeyProtectionError("UNSUPPORTED_PLATFORM");
  if (!/^ws_[A-Za-z0-9_-]{16,64}$/.test(workspaceId)) throw new KeyProtectionError("INVALID_ARGUMENT");
  const base = env["LOCALAPPDATA"];
  if (!base) throw new KeyProtectionError("UNSUPPORTED_PLATFORM");
  return win32.join(base, "SAKLAZ", workspaceId, "kek.bin");
}
