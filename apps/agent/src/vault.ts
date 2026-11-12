/**
 * Gizli bilgi kasası — veritabanının DIŞINDA tutulan değerler.
 *
 * Kasada şunlar tutulur:
 *   • veritabanı şifreleme anahtarı
 *   • cihaz özel anahtarları
 *   • geri yükleme korumasının monoton durum dönemi (ADR-0016)
 *
 * Kasanın veritabanı yedeğine DAHİL OLMAMASI, geri yükleme tespitinin temelidir.
 *
 * Uygulamalar:
 *   • WindowsDpapiVault — Sprint 3'te, Windows CI'da doğrulanarak eklenecek. Bu sprintte YOK.
 *   • InsecureFileVault — yalnızca test ve geliştirme içindir; üretim kipinde açılmayı reddeder.
 *   • MemoryVault — birim testleri.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretVault {
  get(name: string): Uint8Array | undefined;
  set(name: string, value: Uint8Array): void;
  /** Kasanın türü; denetim kaydında ve durum ekranında gösterilir. */
  readonly kind: "dpapi" | "insecure-file" | "memory";
}

export class MemoryVault implements SecretVault {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, Uint8Array>();
  get(name: string): Uint8Array | undefined {
    const v = this.m.get(name);
    return v ? v.slice() : undefined;
  }
  set(name: string, value: Uint8Array): void {
    this.m.set(name, value.slice());
  }
  /** Test: kasayı tamamen değiştirmek (ör. geri yükleme senaryoları) için anlık görüntü. */
  snapshot(): Map<string, Uint8Array> {
    return new Map([...this.m].map(([k, v]) => [k, v.slice()]));
  }
  restore(s: Map<string, Uint8Array>): void {
    this.m.clear();
    for (const [k, v] of s) this.m.set(k, v.slice());
  }
}

/**
 * GÜVENSİZ dosya kasası: değerler düz metin (hex) olarak diske yazılır.
 * Yalnızca SAKLAZ_INSECURE_VAULT=1 ortam değişkeni açıkken çalışır; aksi halde hata verir.
 */
export class InsecureFileVault implements SecretVault {
  readonly kind = "insecure-file" as const;
  private data: Record<string, string>;

  constructor(private readonly path: string) {
    if (process.env["SAKLAZ_INSECURE_VAULT"] !== "1") {
      throw new Error("InsecureFileVault yalnızca test/geliştirme içindir (SAKLAZ_INSECURE_VAULT=1 gerekli).");
    }
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
  }

  get(name: string): Uint8Array | undefined {
    const v = this.data[name];
    return v === undefined ? undefined : Uint8Array.from(Buffer.from(v, "hex"));
  }

  set(name: string, value: Uint8Array): void {
    this.data = { ...this.data, [name]: Buffer.from(value).toString("hex") };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path); // atomik değiştirme
  }
}
