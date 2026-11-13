# Sprint 3 — Aşama 2 Raporu: Relay'in Docker Ortamına Taşınması

> **Tarih:** 2026-11-13
> **Durum:** ✅ A2 tamamlandı. PR #8, GitHub CI'daki **yedi işin tamamında** yeşil (son commit `c36043f`). **Birleştirme ve A3 için proje sahibinin onayı bekleniyor.**
> **PR:** #8 (`s3/a2-docker`, son commit `c36043f`). Taban: `s3/a1-totp-tekrar` (PR #7).
> **Bağımlılık zinciri:** A0 (#6) → A1 (#7) → A2 (#8). A2, A1'in migration'ını (002) ve TOTP tekrar korumasını kullanır. Henüz birleştirilmemiş hiçbir kodun `main`'de olduğu varsayılmadı; her PR bir öncekinin üzerine kuruldu ve CI her PR'da kendi tabanıyla birlikte çalıştı.
> **Birleştirme:** Yapılmadı. `main` dal koruması (K5) hâlâ etkin değil (`protected: false`, rapor yazılırken kontrol edildi).
> **Yedek noktası:** `s3-a2-oncesi` etiketi (yerel).

## 1. Ortam notu (dürüstlük için)

Bu çalışma oturumunda Docker servisi çalıştırılabildi, ama **Docker Hub ve diğer imaj depoları ağ politikasıyla engelliydi**; temel imajlar çekilemedi. Bu yüzden:

- **Yerelde:** üretim derlemesi, imaja girecek bağımlılık yapısı (`pnpm deploy` çıktısı), derlenmiş `dist/main.mjs`'in gerçek PostgreSQL 16 ile ayrı süreç olarak çalıştırılması ve bütün açılış hata senaryoları test edildi.
- **Gerçek Docker ve Compose testleri:** yalnızca GitHub Actions'ta (ubuntu-24.04 sanal makinesi) çalıştı.

**Hiçbir test gerçek bir üretim sunucusunda (VPS veya şirket DMZ) çalışmadı** (bkz. §8).

## 2. Mimari değişiklikler

### 2.1 Relay uygulaması

| Değişiklik | Dosya | Neden |
|---|---|---|
| **Üretim derlemesi.** Relay ve çalışma alanı paketleri (crypto, protocol) esbuild ile tek bir ESM dosyasında paketlenir. Üçüncü taraf paketler dışarıda kalır ve imaja kilit dosyasındaki sürümleriyle kurulur. Paylaşılan bağımlılıklarda sürüm eşleşmesi denetlenir. | `scripts/build.mjs` | Sprint 2'deki "Dockerfile CMD çalışmaz" eksiği giderildi. |
| **Yapılandırma.** Gizli bilgiler yalnızca dosyadan okunur. Ortamda düz gizli değer (`SAKLAZ_DB_PASSWORD`, `SAKLAZ_MFA_KEY`, `DATABASE_URL`, `PGPASSWORD`…) varsa relay **başlamaz**. Bütün ayarlar açılışta doğrulanır. Hata mesajları yalnızca ayar adını içerir, değeri asla. | `src/config.ts` | Kural 6–7 |
| **Veritabanı yapılandırması.** Parola, veritabanı konteyneriyle **aynı** gizli dosyadan okunur; sunucu, kullanıcı ve veritabanı adı gizli olmayan ortam ayarlarıdır. | `src/config.ts` | Parola tek yerde tutulur. |
| **Açılış denetimleri.** Veritabanını üstel geri çekilmeyle bekleme; JWT anahtar çiftinin aynı çifte ait olduğunun imzala-doğrula ile denetlenmesi; MFA anahtarının bu veritabanına ait olduğunun denetlenmesi (anahtardan türetilmiş, geri çevrilemeyen bir HMAC değeri `relay_meta` tablosunda). | `src/startup.ts`, `migrations/003_relay_meta.sql` | Yanlış anahtarla başlatılan relay, kullanıcı girişlerini sessizce bozmak yerine **hiç başlamaz**. |
| **Kontrollü migration.** Uygulanan her dosya SHA-256 özetiyle `schema_migrations` tablosuna yazılır. Her dosya ayrı bir işlem (transaction) içinde uygulanır. Uygulanmış bir dosya değişmişse (`MIGRATION_MODIFIED`) veya veritabanında bu sürümün bilmediği bir dosya varsa (`MIGRATION_UNKNOWN`) relay başlamaz. `check` modu hiçbir şeyi değiştirmez. Ayrı `migrate` komutu vardır. Danışma kilidi korunur. | `src/db.ts` | Kural 4 |
| **Veritabanı kopmasına dayanıklılık.** Havuzun `error` olayı dinlenir; dinlenmezse Node süreci çöker. Bağlantı ve sorgu zaman aşımı vardır. `/readyz` uç noktası eklendi. | `src/db.ts`, `src/server.ts` | Kural 10 |
| **Hata yanıtları.** Beklenmeyen hatalarda istemciye ayrıntı verilmez. Veritabanına ulaşılamıyorsa `503 UNAVAILABLE`, diğer durumlarda `500 INTERNAL`. Önceden Fastify'ın varsayılan yanıtı veritabanı hata metnini istemciye iletebiliyordu. | `src/server.ts` | Bilgi sızıntısının önlenmesi |
| **İstemci IP'si.** `X-Forwarded-For` güveni yapılandırılabilir oldu. Üretimde yalnızca önündeki Caddy'ye güvenilir (1 sekme). Önceden üretim giriş noktası **her** başlığa güveniyordu; relay doğrudan açılsaydı IP başına hız sınırı sahte başlıkla atlatılabilirdi. | `src/server.ts`, `src/config.ts` | A2 sırasında bulunan açık; düzeltildi. |
| **Günlük.** Tek satırlık JSON. İstek günlüklerinde yalnızca yöntem, rota ve durum kodu bulunur; başlık, gövde ve sorgu dizgisi yazılmaz. | `src/run.ts`, `src/server.ts` | Kural 9 |
| **Süreç yönetimi.** Açılış mantığı test edilebilir `run.ts`'e taşındı. `main.ts` yalnızca komutları, sinyalleri (SIGTERM/SIGINT ile düzgün kapanma, en fazla 10 sn) ve çıkış kodlarını yönetir. Yakalanmamış hata sürecin çıkmasıyla sonuçlanır; konteyner yeniden başlatılır. | `src/run.ts`, `src/main.ts` | Kural 9 |

### 2.2 Docker dosyaları

| Dosya | İçerik |
|---|---|
| `infra/relay/Dockerfile` | İki aşama. **build:** pnpm 10.28.0, `--frozen-lockfile --ignore-scripts`, paketleme, `pnpm deploy --prod`. **runtime:** yalnızca `dist/`, `migrations/`, üretim `node_modules` ve `package.json`; dosyalar root'a ait, uygulama kullanıcısı değiştiremez. npm, npx, corepack ve yarn kaldırılır. `USER node` (uid 1000), `HEALTHCHECK` (`/healthz`), `ENTRYPOINT node dist/main.mjs`. Temel imaj özetle sabitlendi. |
| `.dockerignore` | **İzin listesi**: yalnızca gereken manifestler ve kaynak klasörleri. `infra/relay/secrets`, `.env`, `.git`, `node_modules`, testler ve diğer uygulamalar bağlama hiç girmez. |
| `infra/relay/docker-compose.yml` | Çalışma alanı başına **ayrı Compose projesi** (`-p saklaz-personal` / `saklaz-business`). Servisler: `caddy` (yalnızca 443), `relay` (iç ağ), `db` (internete çıkışı olmayan iç ağ, **`db_data` volume'u**). Her serviste: salt okunur kök dosya sistemi, `cap_drop: ALL` (db ve caddy için gereken asgari yetkiler), `no-new-privileges`, sağlık denetimi, `restart: unless-stopped`, günlük döndürme (5 × 10 MB). Relay için `init: true`, 512 MB bellek ve 256 süreç sınırı. Başlatma sırası: db sağlıklı → relay sağlıklı → caddy. Zorunlu ayarlar (`SAKLAZ_RELAY_ID`, `SAKLAZ_RELAY_DOMAIN`) eksikse Compose çalışmaz. Temel imajlar özetle sabitlendi. |
| `infra/relay/Caddyfile` | Yalnızca TLS 1.3; HSTS; `Server` başlığı kaldırıldı; yalnızca `/v1/*`, `/healthz`, `/readyz` iletilir, gerisi 404; istemcinin `X-Forwarded-For` başlığı yok sayılır; yönetim API'si yalnızca 127.0.0.1. |
| `infra/relay/scripts/init-secrets.sh` | Çalışma alanı başına gizli bilgi üretimi (veritabanı parolası, Ed25519 JWT çifti, 32 baytlık MFA anahtarı). **Var olan dosyaların üzerine yazmaz.** Değerleri göstermez. Klasör 0700; relay dosyaları 0400 ve sahibi uid 1000. |
| `infra/relay/README.md` | Kurulum, işletim, kontrollü yükseltme |
| `docs/deploy/RELAY-DAGITIM-GUVENLIGI.md` | TLS ve üretim dağıtım güvenliği (kural 12) |
| `.github/workflows/ci.yml` | Yeni iş: **"Docker — relay imajı ve Compose (A2)"** |

**Temel imajlar:**

| İmaj | Özet |
|---|---|
| `node:22.23.4-bookworm-slim` | `sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` |
| `postgres:16.10-bookworm` | `sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74` |
| `caddy:2.10.2-alpine` | `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` |

### 2.3 İstenen kurallar ve karşılıkları

| # | Kural | Karşılık | Test |
|---|---|---|---|
| 1 | Relay mimarisini Docker'a taşı | Uygulama mimarisi korunarak imaj + Compose; kör relay modeli değişmedi | D-03 |
| 2 | PostgreSQL verisi volume'da | `db_data` volume'u | D-07, D-09 |
| 3 | Yeniden başlatmada veri kaybı yok | Volume + düzgün kapanma; `down` + `up` ve `kill -9` sonrası veri aynı | D-06, D-07, D-09 |
| 4 | Güvenli, idempotent, kontrollü migration | SHA-256 kaydı, dosya başına işlem, check modu, `migrate` komutu, danışma kilidi | D-04; S-07…S-11 |
| 5 | TOTP tekrar koruması sürer | Konteynerde, yeniden başlatma, `down`/`up` ve çökme sonrasında test edildi | D-05…D-09 |
| 6 | Gizli bilgi imaja gömülmez | İzin listeli `.dockerignore`; imaj içerik denetimi; **kanarya testi** | D-01, D-02 |
| 7 | Güvenli ortam ve secret yönetimi | Dosya tabanlı secrets; ortamda gizli değer yasak; değer içermeyen hata mesajları | D-11; S-02…S-05 |
| 8 | Root olmayan kullanıcı | relay uid 1000, CapEff = 0, salt okunur | D-01, D-03 |
| 9 | Sağlık denetimi, otomatik yeniden başlatma, hata günlüğü | HEALTHCHECK, `unless-stopped`, JSON günlük | D-03, D-09 |
| 10 | PostgreSQL kopmasında güvenli toparlanma | Relay çökmez, 503 verir, kendiliğinden toparlanır | D-08; S-14 |
| 11 | Kişisel/kurumsal izolasyon korunur | Ayrı proje, volume, ağ, anahtar, relay kimliği | D-12 |
| 12 | TLS ve üretim güvenliği belgelenir | `docs/deploy/RELAY-DAGITIM-GUVENLIGI.md` | D-03 (TLS 1.3) |

## 3. Test sonuçları

### 3.1 Docker / Compose testleri (yeni CI işi, gerçek imaj ve konteynerler) — 13/13

| ID | Test | İstenen şart |
|---|---|---|
| D-01 | İmaj: kullanıcı `node`; içerik yalnızca `dist`, `migrations`, `node_modules`, `package.json`; `.ts` kaynak yok; `@saklaz` kaynakları yok; npm/npx/corepack/yarn yok; özel anahtar yok; imaj ortamında ve katman geçmişinde gizli bilgi yok | Secret gömülmemesi |
| D-02 | **Kanarya:** repoda `infra/relay/secrets/mfa_key.hex`, `.env` ve `apps/relay/.env` dosyalarına rastgele bir değer yazılır, imaj yeniden derlenir, imajın bütün dosya sistemi dışa aktarılıp değer aranır → **yok** | Secret gömülmemesi |
| D-03 | **İlk kurulum:** gizli bilgiler betikle üretilir, `up --wait`; üç servis `running`/`healthy`; relay uid 1000, CapEff 0, kök dosya sistemi salt okunur, yeniden başlatma politikası `unless-stopped`; relay ve db portu yayımlanmamış, yalnızca Caddy 443 → 127.0.0.1; HTTPS `/healthz` 200, HSTS, `Server` yok, bilinmeyen yol 404; **TLS 1.2 reddedilir, TLS 1.3 kabul edilir** (`openssl s_client`) | Docker ilk kurulum |
| D-04 | **Migration:** 3 dosya kayıtlı; ayrı `migrate` komutu hiçbir şeyi yeniden uygulamaz (`applied_at` değişmez); relay `SAKLAZ_MIGRATE=check` ile sağlıklı açılır | Migration |
| D-05 | **TOTP:** aynı kod ikinci kez 401 (yanlış kodla birebir aynı yanıt); **aynı kodla 10 eşzamanlı girişten tam 1'i başarılı** | TOTP tekrar, eşzamanlı giriş |
| D-06 | **Relay yeniden başlatma:** kullanılmış kod hâlâ reddedilir; önceden alınmış oturum token'ı geçerli kalır; yeni kod kabul edilir | Container yeniden başlatma |
| D-07 | **Kalıcılık:** `compose down` (volume silinmeden) + `up`: hesap sayısı, denetim kaydı sayısı ve en yüksek TOTP adımı birebir aynı; kullanılmış kodlar hâlâ reddedilir | PostgreSQL veri kalıcılığı |
| D-08 | **PostgreSQL kopması:** `db` durdurulur → `/readyz` 503, `/healthz` 200, giriş isteği ayrıntısız `503 UNAVAILABLE` (adres veya hata metni yok); `db` başlatılır → kendiliğinden toparlanma; relay **yeniden başlamadı** (StartedAt ve RestartCount aynı) | Bağlantı kesilmesinde toparlanma |
| D-09 | **Çökme:** relay'in Node süreci ana makineden `kill -9` → konteyner kendiliğinden yeniden başlar ve sağlıklı olur; ardından **PostgreSQL ana süreci `kill -9`** → db yeniden başlar (WAL kurtarma), hesap sayısı aynı, kullanılmış kodlar hâlâ reddedilir, giriş çalışır | Çökme ve yeniden ayağa kalkma |
| D-10 | **Yanlış MFA anahtarı:** relay `MFA_KEY_MISMATCH` ile başlamaz ve sağlıklı olmaz; doğru anahtar geri konunca normale döner | Yanlış anahtar |
| D-11 | **Eksik secret** → `SECRET_FILE_MISSING`; **ortamda secret** → `SECRET_IN_ENV` (değer günlükte yok); boş gizli bilgi klasörüyle Compose kurulumu başarısız; **yanlış veritabanı parolası** → `DB_UNREACHABLE` (parola günlükte yok) | Eksik secret, yanlış anahtar |
| D-12 | **Çalışma alanı izolasyonu:** ikinci kurulum (BUSINESS) aynı makinede; aynı e-posta iki tarafta ayrı hesap; bir alanın token'ı diğerinde **401**; iki ayrı `db_data` volume'u; BUSINESS relay'i PERSONAL veritabanına **ağ üzerinden ulaşamıyor**; MFA anahtarları farklı | İzolasyon |
| D-13 | **Günlük taraması:** iki kurulumun bütün konteyner günlüklerinde (relay, db, caddy) parola, TOTP sırları, MFA anahtarları, JWT özel anahtarları, veritabanı parolaları ve token'lar aranır → **hiçbiri yok** | Secret sızıntısı |

### 3.2 Yeni relay testleri (her CI çalışmasında, Docker'sız) — 23

| ID | Kapsam |
|---|---|
| S-01…S-05 | Yapılandırma: geçerli yapılandırma ve güvenli varsayılanlar; 7 yasaklı ortam adının her biri; eksik, okunamayan ve boş dosya; bozuk MFA anahtarı; parça parça veritabanı yapılandırması (özel karakterli parolanın kodlanması); belirsiz veya eksik yapılandırma; geçersiz ayarlar |
| S-06 | JWT: geçersiz PEM ve eşleşmeyen çift reddi (mesajda anahtar içeriği yok) |
| S-07 | Veritabanı hata sınıflandırması (A2 sırasında bulunan bir `null` hatası da burada düzeltildi) |
| S-08…S-13 | Migration: ilk kurulum ve tekrar; check modu; değiştirilmiş dosya; bilinmeyen dosya; yarıda kalan dosyanın geri alınması; **A1 dönemi (kayıt tablosu olmayan) veritabanının veri kaybı olmadan güncellenmesi** |
| S-14…S-15 | MFA anahtarı denetimi (ilk kurulum, doğrulama, uyuşmazlık; A2 öncesi kurulumda hesap sırrıyla doğrulama) |
| S-16 | Veritabanını bekleme ve zaman aşımı (parola hata mesajında yok) |
| S-17 | **Veritabanı kopması ve toparlanma:** araya konan bir TCP vekili kapatılıp açılarak; `/readyz` 503/200, ayrıntısız 503, toparlanma sonrası giriş |
| S-18 | Günlükçü ve hata açıklaması |
| S-19…S-21 | Süreç içi açılış: başarılı açılış ve ikinci açılış; check modu ve `migrate`; yanlış MFA anahtarı; ulaşılamayan veritabanı |
| S-22…S-23 | Ayrı süreç (`main.ts`): eksik secret, ortamda secret, bilinmeyen komut ve çıkış kodları; tam açılış, SIGTERM ile düzgün kapanma, yanlış anahtarla yeniden açılış reddi |

### 3.3 Toplam (GitHub CI, PR #8)

| İş | Sonuç |
|---|---|
| TypeScript — ubuntu + PostgreSQL | ✅ crypto 34, protocol 88, agent 26, relay 57 = **205** |
| Windows — kripto, protokol, ajan | ✅ 34 + 88 + 26 = 148 |
| Dart | ✅ 7/7 |
| Pester | ✅ 8/8 |
| **Docker — relay imajı ve Compose (A2)** | ✅ **13/13** (≈ 220 sn; özetle sabitlenmiş temel imajlarla) |
| gitleaks, CodeQL | ✅ sızıntı yok, ✅ |

- Linux'ta test sayısı 182'den **205**'e çıktı (relay 34 → 57). Buna ek olarak **13 Docker testi** var.
- Sprint 1, Sprint 2, A0 ve A1 testlerinin **hiçbiri silinmedi, gevşetilmedi veya değiştirilmedi**.
- Relay kapsaması %90,3 (eşik %85). Eşik düşürülmedi ve hiçbir dosya ölçüm dışında bırakılmadı.
- `main.ts` süreç içi kapsamada görünmez, çünkü yalnızca ayrı süreçte çalışır. Bu yüzden açılış mantığı test edilebilir `run.ts`'e taşındı (%93,6). `main.ts` ise ayrı süreç testleri ve Docker testleriyle sınanıyor.

## 4. Güvenlik değerlendirmesi

### 4.1 A2 sırasında bulunan ve düzeltilen sorunlar

| # | Sorun | Etki | Durum |
|---|---|---|---|
| G-1 | Üretim giriş noktası `X-Forwarded-For` başlığına koşulsuz güveniyordu | Relay doğrudan açılsaydı IP başına giriş hız sınırı sahte başlıkla atlatılabilirdi | ✅ Yalnızca 1 sekmeye (Caddy) güvenilir; varsayılan 0 |
| G-2 | Beklenmeyen hatada Fastify'ın varsayılan yanıtı hata metnini istemciye iletebiliyordu | Veritabanı adresi veya iç ayrıntı sızabilirdi | ✅ Ayrıntısız 503/500 |
| G-3 | Havuzun `error` olayı dinlenmiyordu | Veritabanı yeniden başlarken relay süreci çökebilirdi | ✅ Dinleniyor; D-08 ve S-17 ile test edildi |
| G-4 | `isDbUnavailable(null)` istisna fırlatıyordu (yeni kodda, testte bulundu) | Hata işleyicide ikincil hata | ✅ |
| G-5 | Dockerfile çalışmıyordu (Sprint 2'den bilinen) | — | ✅ |

### 4.2 Değerlendirme

- **Gizli bilgiler:** İmajda yok (D-01, D-02 kanarya). Ortam değişkeninde yok; varsa relay başlamaz. Günlüklerde yok (D-13). Hata mesajlarında yok (S-02…S-06, D-11).
- **Yetki:** Relay root değil, Linux yetkisi yok, dosya sistemi salt okunur, kendi kodunu değiştiremez. db ve caddy yalnızca gereken asgari yetkilerle çalışıyor.
- **Ağ:** Dışarıya yalnızca 443 açık. Veritabanı internete çıkışı olmayan iç ağda. İki kurulum birbirine ulaşamıyor.
- **TLS:** Yalnızca 1.3; HSTS. Gerçek alan adında ACME sertifikası **test edilmedi**: CI'da Caddy'nin yerel sertifika yetkilisi kullanıldı.
- **Bütünlük:** Temel imajlar özetle sabitlendi. Migration dosyaları SHA-256 ile kayıtlı; değişirse relay başlamaz. Yanlış MFA veya JWT anahtarıyla başlamaz.
- **Kullanılabilirlik:** Konteyner çökmesi, veritabanı çökmesi ve veritabanı kopması veri kaybı olmadan toparlanıyor; TOTP koruması her durumda sürüyor.
- **Güven modeli değişmedi:** Relay hâlâ güvenilmeyen taraf. A2 yalnızca dağıtım yüzeyini sıkılaştırır; telefon imzası olmadan komut çalıştırılamaması (S4) relay'in güvenliğine bağlı değildir.

## 5. Bilinen riskler

| # | Risk | Açıklama | Önlem / plan |
|---|---|---|---|
| R-A2-1 | Compose secrets tmpfs değil | Swarm olmayan Compose, gizli dosyaları sunucudaki izinleriyle bağlar. Koruma sunucudaki dosya izinlerine dayanır. | `init-secrets.sh` izinleri ayarlar. S5'te Swarm/Podman secrets veya bir sır yöneticisi değerlendirilecek. |
| R-A2-2 | `db_password` 0444 | Hem PostgreSQL (uid 999) hem relay (uid 1000) okuduğu için. Koruma 0700 klasöre dayanır. | Belgelendi. Alternatif: iki ayrı kopya, farklı sahiplerle (S5). |
| R-A2-3 | `docker` grubu root'a eşdeğer | Gruptaki herkes bütün gizli bilgilere erişebilir. | Belgelendi: yalnızca sunucu yöneticileri. |
| R-A2-4 | MFA anahtarı yenilenemiyor | Anahtar kaybı veya sızıntısı, bütün kullanıcıların TOTP'yi yeniden kurmasını gerektirir. | Yeniden şifreleme aracı S5'te. Gizli bilgi yedeği zorunlu. |
| R-A2-5 | Eski imaja geri dönüş | Yeni şemayla eski imaj başlamaz (`MIGRATION_UNKNOWN`); geri dönüş yedekten geri yüklemeyle yapılır. | Bilinçli bir önlem. Güncellemeden önce yedek zorunlu (belgede). |
| R-A2-6 | Güvenlik açığı taraması ve SBOM yok | Temel imajlardaki bilinen açıklar henüz ölçülmüyor. | A9 (GHCR + SBOM + kaynak kanıtı + tarama). |
| R-A2-7 | Yalnızca amd64 | arm64 sunucuda denenmedi. | Kurulacak sunucunun mimarisi S5'te netleşecek. |
| R-A2-8 | ACME sertifikası denenmedi | CI'da Caddy yerel sertifika yetkilisi kullanıldı. | Gerçek alan adıyla S5'te. |
| R-A2-9 | Yalnızca TLS 1.3 | Eski Android sürümleri bağlanamayabilir. | Android uygulamasının en düşük sürümü S4'te bu kısıta göre seçilecek. |
| R-A2-10 | Bellek içi IP hız sınırı | Yeniden başlatmada sıfırlanır; birden fazla relay kopyası arasında paylaşılmaz. | Tek kopya için yeterli; ölçekte S5. |
| R-A2-11 | Canlılık denetimi veritabanını kapsamaz | Bilinçli: veritabanı kısa süre koptuğunda relay gereksiz yere yeniden başlatılmaz. Veritabanı durumu `/readyz`'de. | Dış izleme `/readyz`'i izlemeli (belgede). |
| R-A2-12 | Yedekleme otomatik değil | `pg_dump` ve gizli bilgi yedeği elle yapılıyor. | S5'te IT ile; geri yükleme provası şart. |
| R-A2-13 | Temel imajlar Docker Hub'dan | Tedarik zinciri bağımlılığı. | Özetle sabitlendi; güncellemeler planlı ve CI'dan geçerek. |
| R-A2-14 | HSTS `preload` yok | Bilinçli; alan adı sahibinin kararı. | Belgede. |
| R-A2-15 | Günlükler sunucuda kalıyor | Döndürülüyor ama merkezi bir yere iletilmiyor. | S5'te IT'nin günlük altyapısıyla. |

## 6. Gerçek cihaz doğrulaması

| Platform | Durum |
|---|---|
| **Windows** | A2 Windows ajanını değiştirmez. Windows CI işi (kripto, protokol, ajan) değişmeden yeşil. **Gerçek bir Windows bilgisayarda doğrulanacak bir A2 maddesi yok.** |
| **Android** | Uygulama henüz yok (S4). Relay'in yalnızca TLS 1.3 kabul etmesi, S4'te Android'in en düşük sürüm seçimini etkiler (R-A2-9). **Gerçek telefonla relay bağlantısı denenmedi.** |
| **Gerçek sunucu** | **Denenmedi.** Bütün Docker testleri GitHub'ın geçici ubuntu-24.04 sanal makinesinde çalıştı. Gereksinimler §8'de. |

## 7. Değişen dosyalar

```
.dockerignore                                (yeni)
.github/workflows/ci.yml                     (Docker işi)
apps/relay/package.json, pnpm-lock.yaml      (build betiği; esbuild, tsx [geliştirme]; libsodium-wrappers-sumo [crypto ile aynı sürüm])
apps/relay/scripts/build.mjs                 (yeni)
apps/relay/migrations/003_relay_meta.sql     (yeni)
apps/relay/src/config.ts, startup.ts, run.ts (yeni)
apps/relay/src/accounts.ts, db.ts, server.ts, main.ts, index.ts
apps/relay/test/startup.test.ts              (yeni, 23 test)
apps/relay/test-docker/docker.test.ts        (yeni, 13 test)
apps/relay/vitest.docker.config.ts, tsconfig.json
infra/relay/Dockerfile, docker-compose.yml, Caddyfile, README.md
infra/relay/scripts/init-secrets.sh          (yeni)
docs/deploy/RELAY-DAGITIM-GUVENLIGI.md       (yeni)
```

**Dokunulmayanlar:** `packages/crypto`, `packages/protocol`, `apps/agent`, `apps/mobile` (`git diff` boş).

## 8. Gerçek sunucu doğrulama gereksinimleri (S5, IT ile)

Bunlar yapılmadan relay **üretimde kullanıma alınmamalıdır**:

1. **Sunucu:** Sunucu mimarisi (amd64/arm64), işletim sistemi sürümü, Docker ve Compose sürümü.
2. **Alan adı ve TLS:** Gerçek alan adı, ACME sertifikasının alınması ve yenilenmesi (veya şirket sertifikası), TLS 1.3 ve HSTS'in dışarıdan doğrulanması (ör. `testssl.sh`).
3. **Ağ:** Dışarıdan port taraması: yalnızca 443 açık olmalı. Docker'ın ufw'yi atlaması kontrol edilir. DMZ'de içeriden yalnızca giden 443.
4. **Gizli bilgiler:** `init-secrets.sh` gerçek sunucuda çalıştırılır; izinler doğrulanır; şifreli ve sunucu dışı yedek alınır; geri yükleme denenir.
5. **Veri kalıcılığı ve geri yükleme:** Gerçek diskte `down`/`up`, sunucunun yeniden başlatılması (Docker servisi dahil), `pg_dump` ve geri yükleme provası.
6. **Çökme ve kopma:** D-08, D-09 ve D-10'un gerçek sunucuda tekrarı.
7. **Saat:** NTP'nin çalıştığının doğrulanması (TOTP).
8. **İzleme:** `/readyz` dış izleme, disk doluluğu, yeniden başlatma sayısı uyarıları.
9. **İki çalışma alanı:** PERSONAL (VPS) ve BUSINESS (DMZ) ayrı sunucularda; birinin token'ının diğerinde reddedildiğinin gerçek ortamda doğrulanması.
10. **Gerçek istemciler:** Windows ajanının şirket ağından ve Android uygulamasının (S4) mobil ağdan bağlanması; proxy ve güvenlik duvarı arkasından WSS.
11. **Yük:** Gerçek kullanıcı sayısıyla bellek sınırı (512 MB) ve hız sınırları (S5'teki ölçüm).

## 9. K5 için zorunlu kontrol listesi (güncellendi)

A2 ile **altıncı** bir CI işi eklendi. `main` dal korumasında zorunlu kontrollere bu da eklenmelidir:

1. `TypeScript (lint, sınır, tip, test) — ubuntu + PostgreSQL`
2. `Windows — kripto, protokol ve ajan (SQLCipher yerel modülü)`
3. `Dart uyumluluk vektörleri (S13)`
4. `Windows envanter betiği (Pester, D6)`
5. `Gizli bilgi taraması (gitleaks)`
6. **`Docker — relay imajı ve Compose (A2)`** — yeni

Not: Bu iş PR #8 birleştirilene kadar `main`'de çalışmaz. Zorunlu kontrol olarak #8 birleştirildikten sonra eklenmelidir; daha önce eklenirse #6 ve #7 bu kontrolü hiç alamayacağı için birleştirilemez.

## 10. Sonraki adım

A3'e (Windows DPAPI kasası) **onayınız olmadan geçilmeyecek.**
