/**
 * Kanonik JSON — RFC 8785 (JCS) alt kümesi.
 *
 * İmzalanan her yapı bu biçime çevrilir; böylece TypeScript (ajan, relay, masaüstü) ve Dart
 * (Android) aynı baytları imzalar ve doğrular. FAZ1-PLAN §4.2.
 *
 * Bilinçli kısıt — SAKLAZ alt kümesi:
 *   • Sayılar yalnızca güvenli tam sayı olabilir (|n| ≤ 2^53-1). Kesirli sayılar, -0, NaN ve
 *     Sonsuz reddedilir. Neden: kayan nokta sayılarının metne çevrilmesi diller arasında farklılık
 *     gösterebilir; tek bir uyumsuzluk imza doğrulamasını kırar. Tutar gibi değerler protokolde
 *     kuruş cinsinden tam sayı veya ondalık metin ("1234.50") olarak taşınır.
 *   • Metinler iyi biçimli Unicode olmalıdır (eşsiz vekil karakter yok).
 *   • Yalnızca düz nesneler, diziler, metin, tam sayı, boolean ve null kabul edilir.
 * Bu alt küme RFC 8785 ile tam uyumludur: geçerli her girdi için çıktı RFC 8785 çıktısıyla aynıdır.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const MAX_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function serializeString(s: string): string {
  if (!s.isWellFormed()) throw new CanonicalJsonError("Metin iyi biçimli Unicode değil.");
  // ECMAScript JSON.stringify, RFC 8785 §3.2.2.2 ile aynı kaçış kurallarını uygular.
  return JSON.stringify(s);
}

function write(v: unknown, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError("Yapı çok derin.");
  if (v === null) {
    out.push("null");
  } else if (typeof v === "boolean") {
    out.push(v ? "true" : "false");
  } else if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) {
      throw new CanonicalJsonError("Yalnızca güvenli tam sayılar kabul edilir.");
    }
    out.push(String(v));
  } else if (typeof v === "string") {
    out.push(serializeString(v));
  } else if (Array.isArray(v)) {
    out.push("[");
    v.forEach((item, i) => {
      if (i > 0) out.push(",");
      write(item, depth + 1, out);
    });
    out.push("]");
  } else if (isPlainObject(v)) {
    // RFC 8785 §3.2.3: anahtarlar UTF-16 kod birimlerine göre sıralanır (JS varsayılan sıralaması).
    const keys = Object.keys(v).sort();
    out.push("{");
    let first = true;
    for (const k of keys) {
      const val = v[k];
      if (val === undefined) throw new CanonicalJsonError(`Tanımsız değer: ${k}`);
      if (!first) out.push(",");
      first = false;
      out.push(serializeString(k), ":");
      write(val, depth + 1, out);
    }
    out.push("}");
  } else {
    throw new CanonicalJsonError(`Desteklenmeyen tür: ${typeof v}`);
  }
}

/** Değeri kanonik JSON metnine çevirir. Desteklenmeyen girdide CanonicalJsonError fırlatır. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, 0, out);
  return out.join("");
}

const encoder = new TextEncoder();

/** Kanonik JSON'un UTF-8 baytları (imzalanacak veri). */
export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}
