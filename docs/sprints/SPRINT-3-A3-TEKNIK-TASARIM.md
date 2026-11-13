# Sprint 3 / A3 — Kasa v2 ve Windows DPAPI: Teknik Tasarım

> **Tarih:** 2026-11-13
> **Durum:** 📝 Tasarım. **Uygulamaya başlanmadı.** Proje sahibinin onayını bekliyor.
> **Esas:** `docs/sprints/SPRINT-3-PLAN.md` §2 A3; K2 ve K3 kararları (§8).
> **Taban:** `main` = `0cd9bec`
> **Dil kuralı:** Bu belgedeki güvenlik ifadeleri `SECURITY.md` §0 varsayımlarına bağlıdır; hiçbiri mutlak değildir.

## 0. Bağlayıcı kurallar

| Kaynak | Kural |
|---|---|
| K2 | Minimal yerel eklenti. Gereksiz yetki kullanılmaz. Anahtarlar **hiçbir şekilde düz metin olarak diske yazılmaz.** TPM desteği doğrulanmadan TPM koruması varmış gibi raporlanmaz. |
| K3 | TPM NV sayacı yalnızca araştırılır. Yönetici izni gerektiren uygulama yapılmaz. |
| Proje sahibi (2026-11-13) | Kripto ve protokol paketleri değişmez. KEK ve gizli veri günlüğe yazılmaz. DPAPI başarısız olursa **güvensiz bir yönteme geri düşülmez.** `InsecureFileVault` test dışında kullanılmaz. Mevcut veri kaybedilmez. |

**A3'ün kapsamı:** Kasa v2 dosya biçimi, `KeyProtector` arayüzü, DPAPI koruyucusu, `@saklaz/win-keyprotect` yerel eklentisi, atomik yazım, geçiş, hata yönetimi ve testler.

**Kapsam dışı:** TPM koruyucusu (A4), Windows Hello (S4), TPM NV sayacı (A4, yalnızca araştırma), telefonun tuttuğu üst sınır (A5).

## 1. Mevcut durum (`main`)

- `SecretVault` arayüzü **eşzamanlı**dır: `get(name)`, `set(name, value)` ve `kind`. Ajan çekirdeği (`core.ts`), veritabanı (`db.ts`) ve rollback koruması (`rollback.ts`) doğrudan bu arayüzü kullanır.
- Kasadaki adlar: `db-key`, `agent-sign-seed`, `agent-dh-secret`, `state-epoch`.
- `state-epoch` **gelen her mesajda** yeniden yazılır (rollback koruması). Kasa yazımı bu yüzden sık ve hızlı olmak zorundadır.
- Uygulamalar: `MemoryVault` (testler) ve `InsecureFileVault`. İkincisi düz hex JSON yazar ve yalnızca `SAKLAZ_INSECURE_VAULT=1` iken açılır. **Üretim için kalıcı bir kasa henüz yok.** Sprint 2'de gerçek bir kullanıcı kurulumu olmadığı için korunması gereken üretim verisi de yok (§9).

**Tasarım ilkesi:** `SecretVault` arayüzü **değişmez.** Yeni kasa, aynı arayüzün üçüncü bir uygulamasıdır. Çekirdek, veritabanı ve rollback kodunda değişiklik gerekmez; yalnızca kasayı oluşturan fabrika fonksiyonu eklenir.

## 2. Mimari

```
AgentCore ─┬─ SecretVault (değişmez arayüz)
           │     ├── MemoryVault           (testler)
           │     ├── InsecureFileVault     (yalnızca testler; üretim fabrikası reddeder)
           │     └── FileVaultV2           (YENİ: vault.bin, XChaCha20-Poly1305)
           │              └── KeyProtector (YENİ arayüz)
           │                    ├── DpapiUserProtector  (YENİ; @saklaz/win-keyprotect)
           │                    ├── [A4] TpmDpapiProtector
           │                    └── FakeProtector       (YALNIZCA test; Linux CI'da kasa mantığını sınar)
           └─ openProductionVault() (YENİ fabrika: platforma göre seçer, güvensize geri düşmez)
```

## 3. `KeyProtector` arayüzü

```ts
/** KEK'i (anahtar şifreleme anahtarı) platformun anahtar koruma mekanizmasıyla sarar. */
export interface KeyProtector {
  /** Dosya başlığına yazılır; açılışta beklenenle karşılaştırılır. */
  readonly kind: "dpapi-user" | "test-fake"; // A4: "tpm+dpapi-user"
  /** Bu koruyucunun bağlı olduğu bağlam. AAD'ye girer (§7). Gizli değildir. */
  binding(): ProtectorBinding;
  /** 32 baytlık KEK'i sarar. Hata → VaultError("PROTECT_FAILED"). */
  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array;
  /** Sarılmış KEK'i açar. Başka kullanıcı, başka makine veya bozuk blob → VaultError("UNWRAP_FAILED"). */
  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array;
}

export interface ProtectorBinding {
  /** Windows kullanıcı SID'i, ör. "S-1-5-21-…" */
  userSid: string;
  /** HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid */
  machineGuid: string;
}
```

**Hata sınıfı:** `VaultError(code)`. Kodlar: `UNSUPPORTED_PLATFORM`, `PROTECT_FAILED`, `UNWRAP_FAILED`, `VAULT_FORMAT`, `VAULT_VERSION`, `VAULT_CORRUPT`, `BINDING_MISMATCH`, `PROTECTOR_MISMATCH`, `WRITE_FAILED`, `LEGACY_VAULT_PRESENT`. Mesajlar yalnızca kodu ve kısa bir açıklamayı içerir. Veri, blob, anahtar, yol içeriği veya Windows hata metni **içermez**; yalnızca Win32 hata numarası olabilir.

## 4. `@saklaz/win-keyprotect` (N-API modülü)

### 4.1 Neden yerel modül (K2)

PowerShell yolu, kısıtlı dil modunda (AppLocker/WDAC) çalışmaz ve her çağrıda yarım ila bir saniye sürer. Hazır FFI kütüphaneleri ise üçüncü taraf ikili kodu demektir. Bu modülde ≈ 200 satırlık C kodu, yalnızca Windows'un kendi kütüphanelerine (crypt32, advapi32, kernel32) bağlanır. Kaynak tamamen bizimdir ve kod imzalamaya (S5) hazırdır.

### 4.2 Dışa aktarılan fonksiyonlar (A3)

| Fonksiyon | Windows API | Not |
|---|---|---|
| `protect(data, entropy): Buffer` | `CryptProtectData` | Bayraklar: **`CRYPTPROTECT_UI_FORBIDDEN`**. `CRYPTPROTECT_LOCAL_MACHINE` **kullanılmaz** (makinedeki her kullanıcının açabileceği koruma yasak). Açıklama alanı boş. |
| `unprotect(blob, entropy): Buffer` | `CryptUnprotectData` | `CRYPTPROTECT_UI_FORBIDDEN`. Çıktı JS tamponuna kopyalandıktan sonra `SecureZeroMemory` + `LocalFree`. |
| `userSid(): string` | `OpenProcessToken` + `GetTokenInformation(TokenUser)` + `ConvertSidToStringSidW` | Salt okuma |
| `machineGuid(): string` | `RegGetValueW(HKLM\SOFTWARE\Microsoft\Cryptography, "MachineGuid", RRF_RT_REG_SZ \| RRF_SUBKEY_WOW6464KEY)` | Salt okuma; yönetici gerekmez |
| `replaceFile(src, dst): void` | `MoveFileExW(MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH)` | `ERROR_SHARING_VIOLATION` veya `ERROR_ACCESS_DENIED` gelirse 5 kez, 20–320 ms üstel geri çekilmeyle yeniden denenir (antivirüs/EDR geçici kilitleri) |
| `flushFile(fd): void` | `FlushFileBuffers` | Geçici dosya yeniden adlandırılmadan önce diske yazılır |

**Kullanılmayanlar:** Yönetici yetkisi, ağ erişimi, kayıt defterine yazma, `SeBackupPrivilege` veya başka ayrıcalık, `CryptProtectMemory` (A3'te yok; bkz. §11 R-A3-6).

### 4.3 Paket yapısı

```
packages/win-keyprotect/
  package.json        "name": "@saklaz/win-keyprotect", "os": ["win32"] DEĞİL. Linux'ta da
                      kurulabilir; yükleyici platform dışında UNSUPPORTED_PLATFORM fırlatır.
  binding.gyp         libraries: crypt32.lib, advapi32.lib; /guard:cf /Qspectre /sdl /W4 /WX
  src/keyprotect.c    N-API (node_api.h, C), NAPI_VERSION 8
  index.js, index.d.ts  yükleyici: build/Release/keyprotect.node; yoksa veya win32 değilse
                        UNSUPPORTED_PLATFORM. Sessiz geri düşüş YOK.
  test/               yalnızca win32'de koşar (§3 test planı)
```

### 4.4 Yeni bağımlılık: `node-gyp` (onay gerekiyor)

2026-11-13 değerlendirmesi. Ölçüm, `main`'in geçici bir kopyasında yapıldı ve kopya silindi; repoya hiçbir şey eklenmedi.

| Konu | Bulgu |
|---|---|
| Sürüm | `node-gyp@13.1.0` (npm `latest`, 2026-10-02). Gereken Node: `^22.22.2 \|\| ^24.15.0 \|\| >=26`. CI'daki ve Docker imajındaki Node 22.23.4 uygun. |
| Sabitleme | **Tam sürüm** (`-E`, `"node-gyp": "13.1.0"`); deponun mevcut kuralıyla aynı (bütün geliştirme bağımlılıkları tam sürümle sabit). Bütünlük `pnpm-lock.yaml`'daki `integrity` (sha512) ile denetlenir; CI `--frozen-lockfile` kullanır. Güncellemeler Dependabot üzerinden, ayrı PR'la. |
| Nereye | `packages/win-keyprotect/package.json` → **`devDependencies`**. `apps/agent`'ın üretim bağımlılıklarına girmez. |
| Lockfile etkisi | `pnpm-lock.yaml`'a **15 yeni paket** (≈ 120 satır): `node-gyp@13.1.0`, `tar@7.5.23`, `undici@8.12.4`, `nopt@10.0.1`, `which@7.0.0`, `env-paths@2.2.1`, `graceful-fs@4.2.12`, `proc-log@7.0.0`, `exponential-backoff@3.1.3`, `minizlib@3.1.0`, `chownr@3.0.0`, `yallist@5.0.0`, `abbrev@5.0.0`, `isexe@4.0.0`, `@isaacs/fs-minipass@4.0.1`. `semver` ve `tinyglobby` zaten lockfile'da vardı. Var olan hiçbir paketin sürümü değişmedi. |
| Kurulum betikleri | Yeni 15 paketin **hiçbirinde** `preinstall`, `install` veya `postinstall` betiği yok. `onlyBuiltDependencies` listesine ekleme gerekmez. |
| Çalışma zamanı | Ölçümde `pnpm --filter @saklaz/agent list --prod` çıktısında `node-gyp` **yok**. Çalışma zamanına yeni npm bağımlılığı girmiyor; yerel modülün kendisi yalnızca Windows sistem kütüphanelerine bağlanır. |
| Ağ erişimi (derleme anında) | `node-gyp`, derlenen Node sürümünün başlık dosyalarını `nodejs.org`'dan indirir ve `SHASUMS256.txt` ile doğrular. CI'da GitHub runner'ının ağı kullanılır. Daha sıkı seçenek: `--nodedir` ile yerel başlıklar (S5'te, imzalı derleme hattıyla birlikte değerlendirilecek). |

**Windows CI derleme gereksinimleri** (`windows-2022` runner):

| Gereksinim | Durum |
|---|---|
| Visual Studio 2022, "Desktop development with C++" (MSVC v143, Windows SDK) | Runner imajında kurulu. Ayrı kurulum adımı gerekmez; ilk derlemede günlükten doğrulanacak. |
| Python ≥ 3.12 desteği | `node-gyp` ≥ 10 gerektirir; 13.1.0 bu koşulu sağlıyor. Runner'da Python 3 kurulu. |
| Node 22.23.4 | `actions/setup-node` ile kuruluyor (mevcut adım) |
| Ek adım | `pnpm --filter @saklaz/win-keyprotect run build` (= `node-gyp rebuild`); kurulum betiği yok, açık CI adımı. **Workflow değişikliği; A3 uygulamasında ayrı onayla.** |
| Derleyici bayrakları | `/W4 /WX /sdl /guard:cf /Qspectre` (`binding.gyp` içinde) |

**Not (mevcut durum, `node-gyp` ile ilgili değil):** pnpm ölçüm sırasında var olan bir uyarıyı tekrarladı: `Ignored build scripts: esbuild@0.28.2` (relay derleme aracı). esbuild platform ikilisini isteğe bağlı paketten aldığı için A2'den beri sorunsuz çalışıyor. Bilgi amaçlı not edildi; değişiklik yapılmadı.

**Derleme:** Kurulum betiği (`install` hook) **yok.** Windows CI işinde açık bir adım olarak çalıştırılır: `pnpm --filter @saklaz/win-keyprotect run build`. Böylece `pnpm install` sırasında kod derlenmez; derleme görünür ve denetlenebilir olur. Önceden derlenmiş ikili dağıtım ve Electron için yeniden derleme S4/S5'te, kod imzalamayla birlikte ele alınacak.

**Ajanla ilişki:** `apps/agent`, `@saklaz/win-keyprotect`'i `optionalDependencies` olarak değil, normal çalışma alanı bağımlılığı olarak alır. Modül yüklenemezse üretim fabrikası **hata verir**; güvensiz kasaya geri düşmez.

## 5. KEK

- **Üretim:** `randomBytes(32)` (libsodium `randombytes_buf`). Mevcut `@saklaz/crypto` kullanılır; kripto paketi değişmez.
- **Koruma:** `wrapped = DPAPI_CurrentUser(KEK, entropy)`.
  `entropy = BLAKE2b-256("SAKLAZ-v1/vault-kek" ‖ vaultId)`
  Entropy gizli değildir. Görevi, başka bir uygulamanın aynı kullanıcı adına `CryptUnprotectData`'yı entropy'siz çağırıp blob'u açamamasıdır. Aynı kullanıcıda çalışan, kodumuzu okuyabilen bir saldırgana karşı koruma **sağlamaz** (R-A3-1).
- **Bellek:** KEK, kasa açık kaldığı sürece süreç belleğinde bir `Uint8Array` olarak durur; her yazımda gerekir. `close()` çağrısında `fill(0)` ile sıfırlanır. JS çöp toplayıcısının kopyaları kontrol edilemez; bu bilinen bir sınırdır (R-A3-6).
- **Düz metin olarak diske yazılmaz.** Hiçbir hata yolunda yazılmaz. Günlüğe yazılmaz. Hata nesnesine konmaz.

## 6. `vault.bin` dosya biçimi (sürüm 1)

Bütün tamsayılar büyük uçludur (big-endian).

```
Ofset  Boyut  Alan
0      4      magic        = "SKV2" (ASCII)
4      2      formatVer    = 1
6      1      protector    = 1 (dpapi-user)   [A4: 2 = tpm+dpapi-user; testte 0xF0 = test-fake]
7      1      flags        = 0 (ayrılmış; 0 değilse VAULT_FORMAT)
8      16     vaultId      rastgele, oluşturulurken bir kez
24     8      generation   her yazımda +1 (u64)
32     4      wrappedLen   (u32, 1..4096)
36     N      wrappedKek   DPAPI blob'u
36+N   24     nonce        XChaCha20-Poly1305, her yazımda rastgele
60+N   4      ctLen        (u32)
64+N   M      ciphertext   şifreli yük + 16 bayt etiket
```

- **Başlık (header):** 0'dan `64+N`'ye kadar olan bölüm. Tamamı AAD'ye girer (§7). Başlıktaki herhangi bir bit değişirse çözme başarısız olur.
- **Yük (payload, şifreli):** Sıralı TLV.
  ```
  u16 count
  tekrar: u8 nameLen | name (UTF-8, ^[a-z0-9-]{1,64}$) | u32 valueLen (≤ 64 KiB) | value
  ```
  Adlar alfabetik sıradadır; aynı ad iki kez bulunamaz. JSON veya hex **kullanılmaz**: sırlar JS'te dize olarak dolaşmaz.
- **Boyut sınırı:** Dosya en fazla 1 MiB. Daha büyükse `VAULT_FORMAT` (bellek tüketme saldırısına karşı).
- **Ayrıştırma:** Önce yalnızca uzunluklar ve sınırlar denetlenir, sonra AEAD çözme yapılır. Etiket doğrulanmadan yükten hiçbir şey kullanılmaz.

## 7. AAD (ilişkili veri) ve bağlam bağlama

```
AAD = "SAKLAZ-v1/vault" ‖ 0x00
    ‖ header[0 .. 64+N)
    ‖ u16 len ‖ userSid (UTF-8)
    ‖ u16 len ‖ machineGuid (UTF-8, küçük harf)
```

| Bağlama | Neyi engeller | Neyi engellemez |
|---|---|---|
| DPAPI (CurrentUser) | Başka bir Windows kullanıcısının veya başka bir makinedeki yabancının KEK'i açması | Aynı kullanıcı adına çalışan kötü amaçlı yazılım (R-A3-1); etki alanı yedek anahtarıyla kurtarma (R-A3-2) |
| AAD'deki `userSid` | Dosyanın aynı makinede başka bir kullanıcının profiline kopyalanması (DPAPI zaten engeller; ikinci katman) | — |
| AAD'deki `machineGuid` | **Dolaşan (roaming) profilde**, aynı etki alanı kullanıcısının dosyayı **başka bir makinede** açması. DPAPI CurrentUser anahtarları dolaşan profille birlikte taşınır; AAD bunu durdurur. | MachineGuid gizli değildir; makinede yönetici olan biri onu değiştirebilir veya taklit edebilir |
| Başlık AAD'de | Koruyucu türünün, sürümün, `vaultId`'nin veya `generation`'ın değiştirilmesi | Dosyanın bütünüyle eski bir kopyayla değiştirilmesi (aşağı) |

**Eski kopyayla değiştirme (vault rollback):** Eski bir `vault.bin` dosyası geri konursa AEAD bunu fark etmez, çünkü eski kopya da geçerlidir. Sonuç: `state-epoch` geri gider. Mevcut rollback koruması (ADR-0016) yalnızca "veritabanı dönemi < kasa dönemi" durumunu yakalar. Kasa tek başına geri alınırsa veritabanı ileride kalır ve bu durum güvenli kabul edilir: tekrar oynatma kaydı veritabanında olduğu için tekrar oynatma kapısı açılmaz. Hem kasa hem veritabanı birlikte geri alınırsa tespit edilmez; bu, planda R3-1 olarak kabul edildi ve A4/A5'te ele alınacak. `generation` alanı A5'teki telefon üst sınırı için hazırdır.

**Yan etki (bilinçli):** Windows yeniden kurulumu, sysprep veya makine kopyalama MachineGuid'i değiştirir; kasa açılmaz (`BINDING_MISMATCH`). Bu durumda kurtarma yolu yeniden eşleştirmedir (§10).

## 8. Atomik yazım

Her `set()` çağrısında:

1. Yeni yük oluşturulur, yeni nonce üretilir, `generation + 1` yazılır, şifrelenir.
2. `vault.bin.tmp-<pid>-<rastgele>` dosyası `wx` (yalnızca yeni dosya) ile açılır → yazılır → `FlushFileBuffers` → kapatılır.
3. `replaceFile(tmp, vault.bin)`: `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`, sınırlı yeniden denemeyle.
4. Başarısızsa geçici dosya silinir, bellekteki durum **değiştirilmez** ve `WRITE_FAILED` fırlatılır. Çağıran taraf mesajı onaylamaz (mevcut "hata varsa ack yok" davranışı).
5. Bellekteki önbellek ancak 3. adım başarılı olduktan sonra güncellenir.

**Çökme garantisi:** `vault.bin` her an ya eski ya yeni geçerli haldedir. Açılışta artık `.tmp-*` dosyaları bulunursa silinir; içerikleri hiç kullanılmaz.

**Eşzamanlılık:** Kasa tek bir süreç tarafından açılır. Açılışta `vault.lock` dosyası `wx` ile oluşturulur ve süreç boyunca açık tutulur; Windows'ta paylaşım kipi nedeniyle ikinci süreç onu açamaz. İkinci bir ajan süreci `VAULT_LOCKED` alır.

**Başarım:** `state-epoch` her mesajda yazılır. Yazım ≈ 1 KB AEAD + fsync + rename demektir; Windows'ta bunun 2–20 ms olması bekleniyor. Bu **ölçülecek** (test planı T-A3-30). 20 ms'yi aşarsa, kalıcı yazım gerçekleşmeden onay gönderilmemesi koşuluyla toplu yazım tasarlanacak; garanti zayıflatılmayacak.

**Konum ve izinler:** `%LOCALAPPDATA%\SAKLAZ\<workspaceId>\vault.bin`. Local seçildi, Roaming değil; dosya dolaşan profille başka makineye taşınmaz. Klasör kullanıcı profilinin ACL'ini devralır (kullanıcı + SYSTEM + Administrators). Her çalışma alanının (PERSONAL/BUSINESS) **ayrı** kasa dosyası, ayrı `vaultId`'si ve ayrı KEK'i vardır.

## 9. Sprint 2 kasasından geçiş

**Gerçek durum:** Sprint 2'de üretim kasası yoktu. Var olan tek kalıcı kasa, `SAKLAZ_INSECURE_VAULT=1` ile açılan geliştirme amaçlı `InsecureFileVault` (düz hex JSON). Gerçek bir kullanıcı kurulumu bulunmuyor. Bu yüzden geçiş yalnızca **geliştirme veya test kurulumları** için anlamlıdır.

**Tasarım (A3'te kod olarak yazılır, bu aşamada ÇALIŞTIRILMAZ):**

- Geçiş **otomatik değildir.** Açılışta `vault.bin` yoksa ve eski güvensiz dosya (`vault.json`) varsa, üretim fabrikası `LEGACY_VAULT_PRESENT` hatasıyla durur. Sessizce ne yeni kasa oluşturur ne eskiyi okur.
- Açık komut: `saklaz-agent vault migrate --from <yol>`, yalnızca `SAKLAZ_INSECURE_VAULT=1` iken.
  1. Eski dosya okunur; adlar ve uzunluklar doğrulanır.
  2. Yeni KEK üretilir, `vault.bin` yazılır.
  3. **Doğrulama:** `vault.bin` yeniden açılır; her değer eskisiyle bayt bayt karşılaştırılır; veritabanı yeni kasadaki `db-key` ile açılabiliyor olmalıdır.
  4. Ancak doğrulama başarılıysa eski dosya `vault.json.migrated-<zaman>` olarak yeniden adlandırılır. **Silinmez**; silme kararı kullanıcınındır. Düz metin bir dosyanın SSD'de güvenle silinmesi garanti edilemez; bu belgelenir.
  5. Herhangi bir adım başarısız olursa yeni dosya silinir, eski dosyaya dokunulmaz.
- **Veri kaybı olmaz:** Eski dosya ancak yeni kasa doğrulandıktan sonra adlandırılır, asla silinmez.

## 10. Hata ve kurtarma senaryoları

| Durum | Davranış | Kurtarma |
|---|---|---|
| Kasa yok, ilk açılış | Yeni KEK ve `vault.bin` oluşturulur | — |
| Yerel modül yok veya Windows değil | `UNSUPPORTED_PLATFORM`; ajan başlamaz. **Güvensiz kasaya geri düşmez.** | Doğru kurulum |
| DPAPI `unwrap` başarısız: başka kullanıcı, yönetici parola sıfırlaması, bozuk profil | `UNWRAP_FAILED`; ajan başlamaz; dosyaya dokunulmaz | Aşağıdaki not |
| `machineGuid` veya `userSid` uyuşmuyor | `BINDING_MISMATCH` | Yeniden eşleştirme |
| Bozuk dosya: magic, sürüm, uzunluk, etiket | `VAULT_FORMAT` / `VAULT_VERSION` / `VAULT_CORRUPT`; ajan başlamaz; dosya **değiştirilmez ve silinmez** (inceleme için) | Yedekten veya yeniden eşleştirme |
| Bilinmeyen koruyucu türü | `PROTECTOR_MISMATCH` | — |
| Yazım başarısız (disk dolu, kilit) | `WRITE_FAILED`; bellekteki durum ve dosya eski halinde; mesaj onaylanmaz | Kendiliğinden yeniden deneme (relay yeniden teslim eder) |
| Artık `.tmp-*` dosyaları | Açılışta silinir | — |
| İkinci ajan süreci | `VAULT_LOCKED` | — |
| Eski güvensiz kasa var | `LEGACY_VAULT_PRESENT` | `vault migrate` komutu (§9) |

**Yedekleme ve kurtarma değerlendirmesi:**

- `vault.bin` **tasarım gereği** yalnızca aynı kullanıcı ve aynı makinede açılır. Dosya yedeği başka bir makinede işe yaramaz; aynı makinede, Windows yeniden kurulmadıysa işe yarar.
- Veritabanı yedeği kasa olmadan açılamaz, çünkü `db-key` kasadadır.
- **Önemli Windows davranışı:** Kullanıcı kendi parolasını değiştirirse DPAPI sorunsuz çalışmaya devam eder. Ancak bir **yönetici parolayı sıfırlarsa** (kullanıcının eski parolası olmadan), yerel hesapta DPAPI anahtarlarına erişim **kalıcı olarak kaybolur**. Etki alanı hesaplarında etki alanı yedek anahtarı kurtarmaya izin verir. Bu, Windows'un bilinen ve belgelenmiş davranışıdır; kullanıcı belgesinde açıkça yazılacak.
- **A3'teki kurtarma yolu:** Kasa kaybedilirse ajan yeni kimlikle **yeniden eşleştirilir**; eski cihaz telefondan iptal edilir; yerel geçmiş (SQLCipher veritabanı) kurtarılamaz. Kurtarma anahtarıyla geri yükleme Sprint 6'da (bağımsız güvenlik testi şartlı).

## 11. Güvenlik riskleri (A3)

| # | Risk | Değerlendirme | Önlem |
|---|---|---|---|
| R-A3-1 | Aynı Windows kullanıcısıyla çalışan kötü amaçlı yazılım | DPAPI'yi ajan gibi çağırıp KEK'i açabilir. Entropy gizli değildir. `SECURITY.md` §0 varsayımlarının dışında. | Kritik işlemler telefon imzası gerektirir (S4). TPM ve Windows Hello sonraki aşamalarda. Raporlarda açıkça belirtilir. |
| R-A3-2 | Etki alanı yönetici yedek anahtarı | Etki alanı yöneticisi DPAPI blob'larını açabilir | Kurumsal ortamda kabul edilmiş bir güven; belgelenir. TPM (A4) bunu daraltır. |
| R-A3-3 | Kasanın eski kopyayla değiştirilmesi | AEAD fark etmez (§7) | Mevcut ADR-0016 kapsamında kabul edildi; A5'te telefon üst sınırı |
| R-A3-4 | Antivirüs veya EDR'ın dosyayı kilitlemesi | Yazım başarısız olabilir | Sınırlı yeniden deneme; hata varsa onay yok; gerçek cihazda ölçülür |
| R-A3-5 | Yerel modülün tedarik zinciri | Yerel kod | Kaynak bizim, derleme CI'da; kod imzalama S5'te |
| R-A3-6 | KEK'in bellekte kalması | Bellek dökümünde görülebilir | `close()`'da sıfırlama. `CryptProtectMemory` A4'te değerlendirilir. |
| R-A3-7 | Yönetici parola sıfırlaması | Kasa kalıcı olarak açılamaz | Belgelenir; kurtarma yolu yeniden eşleştirme |
| R-A3-8 | Eski güvensiz kasa dosyasının diskte kalması | Düz metin | Geçiş komutu yeniden adlandırır ve kullanıcıyı uyarır |

## 12. Dosya bazında değişiklik planı (uygulama aşamasında)

| Dosya | Değişiklik |
|---|---|
| `packages/win-keyprotect/**` | **Yeni** (§4) |
| `apps/agent/src/vault.ts` | `SecretVault` arayüzü **değişmez**. `kind`'a `"file-v2"` eklenir. `InsecureFileVault` ve `MemoryVault` değişmez. |
| `apps/agent/src/vault-v2.ts` | **Yeni:** `FileVaultV2` (biçim, AEAD, atomik yazım, kilit) |
| `apps/agent/src/protectors/types.ts`, `dpapi.ts`, `fake.ts` | **Yeni** (`fake.ts` yalnızca testten içe aktarılır; sınır denetimi üretim kodundan içe aktarılmasını engeller) |
| `apps/agent/src/vault-factory.ts` | **Yeni:** `openProductionVault()`. win32 + yerel modül zorunlu; güvensiz kasaya geri düşüş yok. |
| `apps/agent/src/vault-migrate.ts` | **Yeni:** açık geçiş komutu (§9) |
| `apps/agent/src/index.ts` | Dışa aktarımlar |
| `apps/agent/package.json`, `pnpm-lock.yaml` | `@saklaz/win-keyprotect` (çalışma alanı), `node-gyp` (geliştirme) |
| `apps/agent/test/vault-v2.test.ts`, `vault-dpapi.test.ts`, `vault-migrate.test.ts` | **Yeni** (test planı) |
| `tools/ci/check-boundaries.mjs` | `protectors/fake` dosyasının üretim kodundan içe aktarılmasının engellenmesi |
| `.github/workflows/ci.yml` | Windows işine yerel modül derleme adımı ve ikinci kullanıcı testi. **Workflow değişikliği; ayrı onay.** Mevcut iş ve kontrol adları değişmez. |
| `docs/adr/0017-kasa-v2-kek.md` | **Yeni** ADR |
| `SECURITY.md` | S-kontrol tablosu, A3 sonunda |

**Dokunulmayanlar:** `packages/crypto`, `packages/protocol`, `apps/relay`, `apps/mobile`, ajan iletişimi (`transport.ts`, `e2e`), `core.ts`'in mantığı, `db.ts`, `rollback.ts`.

## 13. Gerçek Windows bilgisayarında doğrulama

Ayrıntılı adımlar SPRINT-3-A3-TEST-PLANI.md §5'te. Özet: CI'daki Windows Server 2022 sanal makinesi; gerçek bir Windows 10/11 bilgisayarı, etki alanı üyeliği, dolaşan profil, EDR, gerçek kullanıcı parola değişikliği ve gerçek uyku/yeniden başlatma döngülerini temsil etmez. A3 raporunda bu maddeler **"gerçek cihazda doğrulanmadı"** olarak kalır; ta ki proje sahibi veya BT test kitini çalıştırıp sonucu paylaşana kadar.

## 14. Onay gereken kararlar

1. `node-gyp`'in geliştirme bağımlılığı olarak eklenmesi (§4.4).
2. Windows CI işine iki adımın eklenmesi: yerel modül derleme ve ikinci yerel kullanıcıyla izolasyon testi. Bu bir workflow değişikliğidir (§12).
3. MachineGuid bağlamasının bilinçli sonucu: Windows yeniden kurulursa veya makine klonlanırsa kasa açılmaz ve yeniden eşleştirme gerekir (§7).
4. Geçişin otomatik değil, açık komutla yapılması (§9).
