# Sprint 3 — Planlama Raporu (onay bekliyor)

> **Tarih:** 2026-11-12
> **Durum:** ⏸ Proje sahibinin onayını bekliyor. Bu rapor için **hiçbir kod değiştirilmedi.**
> **Kaynaklar:** Sprint 2 kaynak kodu ve testleri, `SECURITY.md` v0.3 (S1–S23), `docs/FAZ1-PLAN.md` §13 (13 haftalık plan), `docs/sprints/SPRINT-2-RAPOR.md` ve **yeni repodaki ilk gerçek GitHub CI çalışması**.
> **Dil kuralı:** Bu belgedeki hiçbir güvenlik ifadesi mutlak değildir. Hepsi `SECURITY.md` §0'daki V1–V7 varsayımlarına bağlıdır.

## 0. Başlangıç Durumu

### 0.1 Repo ve yedek

| Madde | Durum |
|---|---|
| Yeni repo | `SAKLAZ5341/Saklaz-Ai-Business-Yeni-`. Sprint 1–2'nin tüm geçmişi `main` dalına gönderildi (`0fbba5b`). Repodaki ilk README commit'i geçmişe birleştirildi; kodda değişiklik yok. |
| Yedek noktası | `yedek/sprint2-son` dalı, Sprint 2'nin son commit'i olan `1c13208`'i gösterir. Yerelde ayrıca `sprint2-son` etiketi var. Etiketi GitHub'a göndermek bu oturumun ağ geçidince engellendi; bu yüzden yedek dal olarak gönderildi. |
| Eski repo | Kullanılmıyor. |

### 0.2 İlk gerçek GitHub CI sonucu (`main`, `0fbba5b`)

Bu, projenin GitHub Actions üzerindeki **ilk** çalışmasıdır. Daha önce testler yalnızca geliştirme ortamında (Linux) koşuyordu.

| İş | Sonuç | Anlamı |
|---|---|---|
| TypeScript: lint, sınır, tip, test — ubuntu + PostgreSQL 16 | ✅ Geçti | S3, S4, S5, S18, S19 testleri artık GitHub CI'da da yeşil. |
| Gizli bilgi taraması (gitleaks) | ✅ Geçti | |
| Windows envanter betiği (Pester, Windows Server 2022) | ✅ Geçti | Betik ilk kez gerçek bir Windows ortamında (CI sanal makinesi) çalıştı. **Hedef şirket bilgisayarında hâlâ çalıştırılmadı.** |
| CodeQL | ✅ Geçti | |
| **Windows — kripto, protokol, ajan** | ❌ **Kaldı** | Kripto (4 dosya) ve protokol (8 dosya) testleri geçti. **Ajan testlerinin 17'sinden 14'ü kaldı.** Bkz. B1. |
| **Dart uyumluluk vektörleri (S13)** | ❌ **Kaldı** | 7 testin 6'sı geçti, 1'i kaldı. Bkz. B2. |

**B1 — Windows'ta `EBUSY: resource busy or locked, unlink ...agent.db`.** Kalan 14 testin hepsi aynı hatayı veriyor: test sonunda geçici klasör silinirken veritabanı dosyası hâlâ açık. Linux açık dosyanın silinmesine izin verdiği için bu hata geliştirme ortamında görünmedi. İki olası kaynak var:

- Bazı testler ajanı her yolda kapatmıyor (test hatası).
- `openAgentDb` yanlış anahtarla açılış gibi bir hatada `Database` tanıtıcısını kapatmadan istisna fırlatıyor (`apps/agent/src/db.ts` 47–52. satırlar). Bu **üretim kodunda bir kaynak sızıntısıdır**.

Kesin kök neden Aşama 0'da belirlenecek. Bu iş Sprint 2'de "Windows CI bekliyor" olarak işaretlenmişti; **Windows doğrulamasının neden zorunlu olduğunu gösteren somut bir bulgudur.**

**B2 — Dart testinde onay özeti uyuşmuyor.** TypeScript tarafı v0.3'te onay özetine `workspaceId` alanını ekledi. Dart testi Sprint 1'de yazıldı ve hiç çalıştırılmadığı için bu alan eklenmedi. Kripto veya JCS uyuşmazlığı **değildir**: aynı dosyadaki Ed25519, BLAKE2b, X25519, imzalı komut ve JCS testleri birebir uyumlu. Düzeltme testin kendisinde yapılacak. Ancak bu, **telefon uygulamasında aynı hatanın yapılabileceğini** gösterir. Önlem olarak Dart testi özeti tek tek alanlardan elle kurmak yerine vektör dosyasındaki bağlamın tamamını kullanacak (A0).

**Kural 6 gereği:** CI kırmızıyken başka bir aşamaya geçilmez. Bu nedenle Aşama 0 zorunludur ve önce yapılır.

### 0.3 Açık Dependabot istekleri

Repo açılır açılmaz 5 Dependabot isteği oluştu (#1–#5). Hepsi GitHub Actions sürüm yükseltmeleri: checkout 7.0.1, setup-node 7.1.0, pnpm/action-setup 6.1.1, codeql-action 4.39.3. Hepsi **ana sürüm** değişikliğidir. A9'da tek tek incelenecek; otomatik birleştirme yapılmayacak.

## 1. Sprint 3 Kapsamının 13 Haftalık Planla Uzlaştırılması

`FAZ1-PLAN.md` §13'te S3 şöyle tanımlıydı: **"Ajan çekirdeği ve araçlar"** (orkestratör, politika motoru, yetenekler ve klasör izinleri, worker havuzu, Faz 1 araçları, RuleEngine, DataGuard, Excel/Raporlama ve Kişisel Asistan ajanları, DPAPI). Sizin Sprint 3 önceliklerinizin ağırlığı ise **sağlamlaştırma ve doğrulama** üzerinde.

| Madde | Eski S3 planında | Yeni öncelik listesinde | Önerilen yer |
|---|---|---|---|
| DPAPI kasası | Var | 1 | **S3** |
| TPM araştırması | Yok | 2 | **S3** |
| TOTP tekrar kullanımı, replay/rollback, iptal, sıralama/teslim | Yok (S2 artıkları) | 3–6 | **S3** |
| Kritik komutlarda onay + izin kontrolü | Politika motoru ve yetenekler | 7 | **S3**: yetenek modeli, politika motoru, onay akışı, klasör izni doğrulaması (S8) ve ilk iki salt okunur araç (`fs.list`, `fs.stat`) |
| Docker doğrulaması | S2 (eksik kaldı) | 8 | **S3** (CI'da) |
| GitHub Actions CI/CD | S1 (hiç çalışmamıştı) | 9 | **S3** |
| Gerçek cihaz test hazırlığı | S4 | 10 | **S3**: test kiti ve plan. Yürütme proje sahibi veya BT tarafından yapılır. |
| Orkestratör, worker havuzu, RuleEngine, DataGuard (S9), xlsx/pdf/docx araçları, rapor araçları, Excel/Kişisel Asistan ajanları, prompt injection paketi (S11) | S3 | — | **Yeni S3b** |

**Tahmini etki:** Yeni öncelikler ≈ 3 hafta sürer (eski S3 için 2 hafta ayrılmıştı). Çıkarılan araç ve orkestratör işleri ≈ 2 hafta. Bu da toplam planı **≈ 13 haftadan ≈ 16 haftaya** çıkarır.

| Seçenek | Açıklama | Değerlendirme |
|---|---|---|
| **K1-A (önerilen)** | S3 = sağlamlaştırma (3 hf), S3b = araçlar ve orkestratör (2 hf). Sonraki sprintler kayar. Toplam ≈ 16 hafta. | Güvenlik çekirdeği, üzerine araç kurulmadan önce doğrulanır. |
| K1-B | S3b, S5'e (sağlamlaştırma) sıkıştırılır. Toplam ≈ 14 hafta. | S5'teki ele geçirilmiş relay ve fuzz işleri zayıflar. Önermiyorum. |
| K1-C | Araçlar Faz 1 dışına çıkarılır. | Faz 1 çıkış kriteri 1 ("Excel'leri özetle") karşılanmaz. Önermiyorum. |

## 2. Teknik Görev Listesi (aşamalar)

Her aşama küçük, ayrı commit'lenir ve kendi testleriyle gelir. Bir aşamanın testleri **Linux CI ve Windows CI'da yeşil olmadan** sonraki aşamaya geçilmez. Her aşamanın başında yerel bir etiket ve `yedek/s3-aN` dalı oluşturulur.

| # | Aşama | Öncelik | Tahmin |
|---|---|---|---|
| **A0** | CI'ı yeşile çekmek: Windows dosya tanıtıcısı (B1), Dart testi (B2) | Ön koşul | 0,5 gün |
| **A1** | TOTP tekrar kullanım koruması | 3 | 0,5 gün |
| **A2** | Docker: derleme adımı, imaj ve CI'da compose duman testi | 8 | 1,5 gün |
| **A3** | Kasa v2: KEK mimarisi + Windows DPAPI | 1 | 2 gün |
| **A4** | TPM: araştırma + isteğe bağlı TPM koruyucusu | 2 | 2 gün |
| **A5** | Replay ve rollback sağlamlaştırması | 4 | 1,5 gün |
| **A6** | Cihaz iptali ve eski anahtar reddi doğrulaması | 5 | 1 gün |
| **A7** | Sıralama ve yeniden teslim: ajan outbox'ı, uçtan uca ack, kesinti testleri | 6 | 2 gün |
| **A8** | Kritik komutlar: yetenek modeli, politika motoru, onay akışı, yol doğrulama (S8), `fs.list`/`fs.stat` | 7 | 3 gün |
| **A9** | CI/CD tamamlama: Docker işi, imaj yayınlama + kaynak kanıtı, Dependabot incelemesi | 9 | 1 gün |
| **A10** | Gerçek cihaz test kiti ve planı | 10 | 1 gün |
| | **Toplam** | | **≈ 16 iş günü ≈ 3 hafta** |

### A0 — CI'ı yeşile çekmek
- B1'in kök nedeni bulunur. `openAgentDb`, açılış sırasındaki her hatada tanıtıcıyı kapatır (`try/catch` + `db.close()`). Testlerde her ajan `try/finally` ile kapatılır.
- Yeni regresyon testi: yanlış anahtarla açma denemesinden sonra dosya silinebilir olmalı. Bu test Windows'ta gerçek anlam taşır.
- Dart testi, onay özetini vektördeki `context` nesnesinin tamamından kurar (B2).

### A1 — TOTP tekrar kullanımı
- `accounts` tablosuna `totp_last_step BIGINT` eklenir (migration `002`).
- Doğrulama tek bir atomik SQL ile yapılır: `UPDATE ... SET totp_last_step=$s WHERE id=$id AND (totp_last_step IS NULL OR totp_last_step < $s) RETURNING id`. Satır dönmezse kod reddedilir.
- Böylece ±1 adım penceresinde aynı kod veya daha eski bir adımın kodu ikinci kez kabul edilmez. Eşzamanlı iki girişte bile yalnızca biri kazanır.

### A2 — Docker
- `apps/relay` için `tsc` ile `dist/` üreten bir derleme adımı eklenir. Bu, Dockerfile'daki bilinen "`.js` uzantılı import" sorununu çözer. Çok aşamalı imaj: derleme aşaması + yalnızca üretim bağımlılıklarını içeren çalışma aşaması.
- İmaj kök olmayan kullanıcıyla, salt okunur dosya sistemiyle ve `cap_drop: ALL` ile çalışır. Taban imaj özetle (digest) sabitlenir.
- CI'da `docker compose up` çalıştırılır ve şunlar doğrulanır: `/healthz`, migration, hesap oluşturma, WSS bağlantısı, veritabanının dış ağa kapalı olması.

### A3 — Kasa v2 ve DPAPI
- **Tasarım:** Kasadaki bütün sırlar tek bir dosyada (`vault.bin`) XChaCha20-Poly1305 ile, rastgele 32 baytlık bir **KEK** altında şifrelenir. KEK, bir **koruyucu** (`KeyProtector`) ile sarılır: önce DPAPI, A4 kabul edilirse ayrıca TPM.
- **Neden:** DPAPI ve TPM yavaştır (onlarca–yüzlerce milisaniye). Rollback korumasının her mesajdaki dönem artışında bu çağrılar yapılamaz. KEK yalnızca açılışta bir kez açılır; sonraki her yazım yalnızca bellek içi AEAD ve atomik dosya yazımıdır (geçici dosya + `fsync` + `rename`).
- Dosya biçiminde sürüm, koruyucu türü ve ilişkili veri (AAD) bulunur. AAD, dosyanın başka bir makineye veya kullanıcıya taşınmasını ve alanların karıştırılmasını tespit eder.
- **DPAPI'ye erişim yolu (karar K2):**

| Seçenek | Artı | Eksi |
|---|---|---|
| **K2-A (önerilen): Kendi küçük N-API eklentimiz** (`@saklaz/win-keyprotect`, ≈ 200 satır C). İçeriği: `CryptProtectData`, `CryptUnprotectData` ve A4 için NCrypt. | Hızlı. Dış bağımlılık yok. Kodu tamamen bizim, ileride kod imzalamayla imzalanır. TPM çağrıları da aynı yerde. | Windows CI'da MSVC ile derleme gerekir. Electron için yeniden derlenir; SQLCipher için zaten gerekiyor. |
| K2-B: PowerShell (`ProtectedData` sınıfı), yalnızca açılışta | Yerel derleme yok. | Şirketlerde AppLocker/WDAC PowerShell'i "Constrained Language Mode"a alırsa bu sınıf **kullanılamaz**. Süreç başlatma ≈ 0,5–1 sn. TPM için `Add-Type` gerekir; o da kısıtlı modda engellenir. |
| K2-C: `koffi` FFI kütüphanesi | Derleme yok. | Üçüncü taraf yerel ikili dosya; tedarik zinciri yüzeyi büyür. |

- `InsecureFileVault` yalnızca test ve geliştirme için kalır. Üretim derlemesinde Windows dışında kasa bulunmaz; yanlışlıkla seçilirse ajan başlamaz (test edilir).
- Sprint 2 kasasından otomatik geçiş yapılır ve test edilir.

### A4 — TPM (araştırma + uygulama)
Araştırma özeti (gerçek donanımda doğrulanacak):

| Konu | Bulgu | Sonuç |
|---|---|---|
| Ed25519/X25519 | TPM 2.0 bu eğrileri desteklemez. | Kimlik ve onay anahtarları TPM'e **taşınamaz**. TPM yalnızca KEK'i sarmak için kullanılır. |
| KEK sarma | Windows "Microsoft Platform Crypto Provider" (NCrypt), dışa aktarılamayan RSA-2048 veya P-256 anahtarı üretir. KEK, RSA-OAEP ile sarılır. Kullanıcı anahtarı için yönetici yetkisi gerekmez. | KEK = DPAPI( TPM-sarma( KEK ) ). Dosyalar ve kullanıcı parolası ele geçirilse bile **başka bir makinede açılamaz**. DPAPI tek başına bunu sağlamaz: alan yedek anahtarı veya kullanıcı kimlik bilgisiyle başka makinede açılabilir. |
| Rollback (tam disk görüntüsü) | DPAPI ve TPM-sarma, **disk görüntüsünün bütünüyle geri yüklenmesine** karşı koruma sağlamaz: veritabanı ve kasa birlikte eski hale döner. Monoton bir sayaç gerekir: TPM NV sayacı. NV dizini tanımlamak çoğu yapılandırmada **yönetici yetkisi** ister ve TPM'in sınırlı NV yazma ömrü vardır. | S3'te: NV sayacı için **prototip ve ölçüm** yapılır; dönem artışı her mesajda değil, seyrek "kontrol noktalarında" yapılır. Üretime alma kararı gerçek cihaz testinden sonra verilir (karar K3). |
| Sanal makineler ve CI | GitHub Windows sanal makinelerinde TPM yoktur. | TPM kod yolu CI'da yazılımsal KSP ("Microsoft Software Key Storage Provider") ile test edilir. **Gerçek TPM ancak gerçek cihazda doğrulanır**; rapor bunu ayrıca gösterecek. |
| TPM olmayan bilgisayar | Ajan DPAPI ile çalışır. Masaüstü ve telefon "donanım korumalı değil" uyarısı gösterir. | Politika "TPM zorunlu" ise ajan başlamaz. |
| Windows Hello | Yerel kilit açma ve yerel onay içindir; Sprint 4'teki UI ile gelir. | S3'te yalnızca `LocalAuthenticator` arayüzü korunur. |

**Tam disk rollback'i için S3'teki gerçekçi önlem (TPM NV sayacı olmadan):** Tespit edilmeyen bir geri yüklemede risk, mesaj ömrüyle sınırlıdır. Kuyruktaki komutlar için en fazla 72 saat, onaylar için ajan saatiyle 10 dakika. A5'te bu pencere, **telefonun tuttuğu bir üst sınırla** daraltılır. Telefon, ajandan aldığı en yüksek imzalı dönem/sayaç değerini saklar ve her yeni oturumda gönderir. Ajan kendi değerinden daha yüksek bir değer görürse geri yüklemeyi tespit eder ve tabanı ayarlar. Sınır: telefon da geri yüklenmişse veya hiç bağlanmazsa bu önlem işe yaramaz.

### A5 — Replay ve rollback sağlamlaştırması
- Kasa v2 ile dönem artışı atomik hale gelir. **Çökme enjeksiyon testi:** her yazım noktasında süreç öldürülür; açılışta yanlış pozitif kilitlenme veya geri yükleme kaçırma olmamalıdır.
- Telefon tarafından taşınan üst sınır (A4'teki önlem). Bu, protokolde yeni bir alan demektir (`agentHigh`), yani vektör sürüm 3 ve Dart güncellemesi gerekir.
- Replay penceresi için `fast-check` özellik testleri: rastgele sıra, tekrar ve atlama; pencere kenarı; 2^53'e yakın sayaçlar.
- `ApprovalLedger`'ın geri yükleme sonrası davranışı: tüketilmiş bir onay, yedekten dönülse bile tabana takılır.
- Ajanın kendi giden sayacı, geri yüklemeden sonra telefonun gördüğü en yüksek değerin üstünden devam eder.

### A6 — İptal ve eski anahtar reddi
Sprint 2'de protokol ve ajan düzeyinde testliydi. S3'te **gerçek relay üzerinden uçtan uca** doğrulanır:
- İptal edilen telefonun **açık Noise oturumu** iptal anında kapanır. Oturum anahtarıyla gelen sonraki çerçeve reddedilir.
- Relay kuyruğunda bekleyen, iptalden **önce** imzalanmış mesajlar iptalden sonra işlenirse reddedilir.
- İptal edilen kimlik veya anahtarla yeniden ekleme girişimi reddedilir. Yeni kimlikle ama eski anahtarla ekleme girişimi de reddedilir.
- Relay'de cihaz devre dışı bırakılınca açık WSS bağlantısı kapanır ve yeni token alınamaz.
- Relay iptal girişini düşürürse (telefona iletmezse) sonuç ölçülür ve raporlanır (S23).
- Not: Anahtar **rotasyonu** (`key-rotate` alanı tanımlı, liste işlemi yok) S3 kapsamında değildir. Ne zaman ele alınacağı S5'te değerlendirilecek.

### A7 — Sıralama ve yeniden teslim
- **Ajan outbox'ı** (SQLCipher): giden her mesaj, uçtan uca `ack` gelene kadar saklanır ve aynı `msgId` ile yeniden gönderilir. Her mesajın bir son kullanma süresi vardır.
- `PhoneSim` aynı outbox davranışını alır (yalnızca test kodu).
- Alıcıda `msgId` ile idempotent işleme: tekrar gelen komut ikinci kez çalışmaz, önceki `ack` yeniden gönderilir.
- **Kesinti testleri** (gerçek relay + PostgreSQL ile):
  - toplu teslimin ortasında bağlantı kopması
  - relay sürecinin yeniden başlatılması
  - ajanın `ack` göndermeden çökmesi
  - aynı çerçevenin iki kez teslimi
  - pencere içinde sırası bozuk sayaçlar

  Bu testler `fast-check` ile rastgele kesinti dizileri olarak da koşar. Ölçüt: her komut **en fazla bir kez** çalışır, süresi dolmamış her komut **en az bir kez** teslim edilir.
- Gönderen başına sıralama garantisi belgelenir. Garanti edilmeyen durumlar da açıkça yazılır.

### A8 — Kritik komutlarda onay ve izin kontrolü
- **Yetenek deposu:** Bütün yetenekler varsayılan olarak kapalıdır. Yalnızca yerelde, `LocalAuthenticator` doğrulamasıyla açılır. Her değişiklik denetim kaydına yazılır.
- **Klasör izinleri ve yol doğrulama (S8):** `realpath`, sembolik link ve junction kaçışı, UNC, `\\?\` önekleri, ADS, 8.3 kısa adlar, sondaki nokta/boşluk ve yasaklı kökler. Açıldıktan sonra tanıtıcının gerçek yolu yeniden kontrol edilir (TOCTOU). Testler Windows CI'da gerçek junction ve kısa adlarla koşar.
- **Politika motoru:**
  - `read`: izin varsa çalışır.
  - `write`: yalnızca `read_write` izni veya çıktı klasörü.
  - `critical`: **her zaman** imzalı telefon onayı ister.
  - Rol kontrolü: `viewer` komut veremez, `operator` kritik işlem onaylayamaz.
  - Kilit veya yerel engelleme varsa hiçbir şey çalışmaz.
- **Onay akışı:** Kritik adım için `approval.request` gönderilir. Gelen karar `ApprovalLedger` ile doğrulanır. Çalıştırmadan hemen önce `assertExecutionMatches` ile parametreler yeniden özetlenir. Onay tek kullanımlıktır ve süresi ajan saatiyle ölçülür.
- **Araç kayıt defteri** ve ilk iki salt okunur araç: `fs.list`, `fs.stat`. Kritik akışı uçtan uca test etmek için yalnızca testte bulunan bir sahte `critical` araç kullanılır. Gerçek `fs.moveToRecycleBin` S3b'dedir.
- **Telefon izin isteği (`grant.request`):** Varsayılan olarak kapalıdır. Organizasyon politikası açarsa `critical` işlem olarak onaya bağlanır.

### A9 — CI/CD
- Docker işi (A2) eklenir. Windows işine yerel eklenti derlemesi eklenir (K2-A seçilirse).
- **CD kapsamı (karar K4):** `main`'e her birleştirmede relay imajı GitHub Container Registry'ye (GHCR) yayımlanır. Yanında SBOM ve kaynak kanıtı (GitHub artifact attestation) bulunur. **Sunuculara otomatik dağıtım yapılmaz.** Dağıtım, şirket BT'sinin kontrolünde, imaj özetiyle ve elle yapılır. Ajan ve Android yayın hattı, kod imzalama kararından sonra S5'te kurulur.
- Dependabot istekleri #1–#5 tek tek incelenir. Her biri kendi CI çalışması yeşil olunca ve sürüm notları okunduktan sonra birleştirilir.
- `main` için dal koruması önerilir: CI zorunlu, doğrudan push yok. Bu ayar repo sahibi olarak sizin tarafınızdan yapılır.

### A10 — Gerçek cihaz test kiti
- `tools/devtest/windows/`: hedef Windows bilgisayarda çalıştırılan, **hiçbir şirket verisine dokunmayan** test paketi. Sentetik veriyle şunları dener:
  - DPAPI kasası
  - TPM varlığı ve sarma
  - SQLCipher
  - rollback senaryosu (veritabanı dosyası geri yükleme)
  - kilit ve yol doğrulama (geçici test klasöründe junction/kısa ad)
  - relay'e giden bağlantı

  Sonuç, makineye özgü bilgiler çıkarılmış bir JSON rapordur.
- `docs/test/GERCEK-CIHAZ-TEST-PLANI.md` (bkz. §6).

## 3. Dosya Bazında Değişiklik Planı

| Dosya | Aşama | Değişiklik |
|---|---|---|
| `apps/agent/src/db.ts` | A0 | Açılış hatasında tanıtıcının kapatılması |
| `apps/agent/test/agent.test.ts` | A0, A5, A6 | `try/finally` kapatma; yeni rollback, çökme ve iptal testleri |
| `apps/mobile/vector_check/test/vectors_test.dart` | A0, A5 | Onay bağlamı vektörden alınır; `agentHigh` alanı eklenir |
| `apps/relay/migrations/002_totp_step.sql` | A1 | **Yeni:** `totp_last_step` |
| `apps/relay/src/totp.ts` | A1 | Doğrulama, eşleşen adımı döndürür |
| `apps/relay/src/accounts.ts` | A1 | Atomik adım kontrolü |
| `apps/relay/test/relay.test.ts` | A1, A6, A7 | TOTP tekrar ve eşzamanlılık; cihaz devre dışı → WSS kapanması; relay yeniden başlatma |
| `apps/relay/package.json`, `apps/relay/tsconfig.build.json` | A2 | **Yeni** derleme betiği ve yapılandırması |
| `infra/relay/Dockerfile`, `docker-compose.yml`, `README.md` | A2 | Çok aşamalı derleme, sıkılaştırma, özetle sabitlenmiş taban |
| `apps/agent/src/vault.ts` | A3 | `SecretVault` arayüzü korunur; `KeyProtector` ve kasa v2 eklenir |
| `apps/agent/src/vault-file.ts` | A3 | **Yeni:** sürümlü dosya biçimi, AEAD, atomik yazım, geçiş |
| `apps/agent/src/protectors/dpapi.ts` | A3 | **Yeni** |
| `apps/agent/src/protectors/tpm.ts` | A4 | **Yeni** |
| `packages/win-keyprotect/` | A3, A4 | **Yeni (K2-A seçilirse):** N-API eklentisi: C kaynağı, `binding.gyp`, TS sarmalayıcı ve testler |
| `apps/agent/src/rollback.ts` | A5 | Atomik dönem; telefon üst sınırı; kontrol noktası arayüzü (TPM NV için) |
| `packages/protocol/src/schemas.ts`, `message.ts` | A5 | `agentHigh` alanı. Geriye dönük uyumsuz bir değişiklik; protokol sürümü `saklaz/1` içinde ve henüz yayımlanmış bir istemci yok. |
| `packages/protocol/scripts/generate-vectors.ts`, `test-vectors/saklaz-v1.json` | A5 | Vektör sürümü 3 |
| `packages/protocol/src/e2e.ts` | A6 | İptal edilen eşin oturumunun anında kapatılması (doğrulanacak; gerekirse düzeltilecek) |
| `apps/agent/src/core.ts` | A5–A8 | Outbox, idempotent işleme, politika ve onay entegrasyonu. Dosya 483 satır; politika ve onay akışı ayrı modüllere çıkarılır. |
| `apps/agent/src/outbox.ts` | A7 | **Yeni** |
| `apps/agent/src/transport.ts` | A7 | Outbox'tan yeniden gönderim |
| `apps/relay/src/hub.ts` | A6, A7 | Devre dışı cihaz bağlantısının kapatılması; teslim sırasının belgelenmesi |
| `apps/agent/src/capabilities.ts` | A8 | **Yeni** |
| `apps/agent/src/grants.ts` | A8 | **Yeni** |
| `apps/agent/src/pathguard.ts` | A8 | **Yeni:** yol doğrulama (S8) |
| `apps/agent/src/policy.ts` | A8 | **Yeni** |
| `apps/agent/src/approvals.ts` | A8 | **Yeni** |
| `apps/agent/src/tools/registry.ts`, `tools/fs-list.ts`, `tools/fs-stat.ts` | A8 | **Yeni** |
| `apps/agent/test/policy.test.ts`, `pathguard.test.ts`, `approvals.test.ts`, `outbox.test.ts`, `vault.test.ts` | A3–A8 | **Yeni** |
| `packages/testkit/src/index.ts` | A7, A8 | Outbox, onay imzalama; yalnızca test kodu |
| `.github/workflows/ci.yml` | A0, A2, A9 | Docker işi; yerel eklenti derlemesi |
| `.github/workflows/release-relay.yml` | A9 | **Yeni:** GHCR + SBOM + kaynak kanıtı |
| `tools/devtest/windows/*` | A10 | **Yeni** |
| `docs/test/GERCEK-CIHAZ-TEST-PLANI.md` | A10 | **Yeni** |
| `SECURITY.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `docs/FAZ1-PLAN.md` §13 | Sprint sonu | Kontrol tablosu, kasa mimarisi, yeni plan |
| `docs/adr/0017-kasa-v2-kek.md`, `0018-tpm.md`, `0019-outbox-teslim.md` | A3, A4, A7 | **Yeni** ADR'ler |
| `docs/sprints/SPRINT-3-RAPOR.md` | Sprint sonu | **Yeni** |

**Dokunulmayacaklar:** Kripto ilkelleri (`packages/crypto`), Noise durum makinesi, imza alanları ve doğrulama hattının sırası. Bunlar Sprint 1–2'de vektörlerle sabitlendi. S3'te değişmeleri gerekmiyor.

## 4. Güvenlik Riskleri

| # | Risk | Etki | Önlem | Kalan risk |
|---|---|---|---|---|
| R3-1 | Tam disk görüntüsü geri yüklemesi (veritabanı + kasa birlikte) | Tespit edilmezse ömrü dolmamış mesajlar yeniden oynatılabilir. | Mesaj ömrü sınırı, telefon üst sınırı (A5), TPM NV prototipi (A4) | Telefon da geri yüklenir veya hiç bağlanmazsa ve TPM NV yoksa tespit edilmez. Pencere ≤ 72 saat. |
| R3-2 | DPAPI'nin kullanıcı kimlik bilgisi veya alan yedek anahtarıyla başka makinede açılması | Kasa ve veritabanı okunur. | TPM-sarma (A4) | TPM'siz bilgisayarlarda devam eder; arayüzde gösterilir. |
| R3-3 | Aynı kullanıcı hesabında çalışan kötü amaçlı yazılım | DPAPI ve TPM'i ajan gibi çağırabilir. | Yok: bu, V-varsayımlarının dışındadır (`SECURITY.md` §0). Kritik işlemler telefon onayı gerektirdiği için etki sınırlanır. | Yüksek; açıkça belgelenir. |
| R3-4 | PowerShell kısıtlı modu veya EDR'ın yerel eklentiyi engellemesi | Ajan başlamaz. | K2-A + gerçek cihaz testi (A10) + kod imzalama (S5) | Gerçek cihazda ölçülecek. |
| R3-5 | TPM NV yazma ömrünün tüketilmesi | TPM arızası. | Seyrek kontrol noktası; her mesajda yazım yok | Prototipte ölçülecek. |
| R3-6 | Kasa yazımı sırasında çökme | Yanlış "geri yükleme" kilidi veya veri kaybı | Atomik yazım + çökme enjeksiyon testi | — |
| R3-7 | Outbox'ın yeniden gönderimiyle kritik işlemin iki kez çalışması | Çift işlem | `msgId` idempotansı; `write`/`critical` adımlar kesintiden sonra otomatik tekrarlanmaz | Test edilecek. |
| R3-8 | Yol doğrulamasında Windows'a özgü kaçışlar | İzin dışı dosyaya erişim | Kapsamlı test seti; Windows CI'da gerçek junction ve kısa ad | Test setine girmeyen yeni teknikler. |
| R3-9 | Onay ekranında gösterilen ile çalıştırılan işlemin farklı olması | Kullanıcı yanıltılır. | Özet = gösterim + parametreler; çalıştırmadan önce yeniden özetleme | Telefon UI'ı S4'te. |
| R3-10 | TOTP sırrının relay veritabanıyla birlikte çalınması | MFA atlanır. | Sır AES-GCM ile şifreli; anahtar ayrı dosyada (mevcut) | Relay sunucusunun tamamen ele geçirilmesi. Bu durumda bile kritik işlem yapılamaz (telefon imzası gerekir). |
| R3-11 | Docker imajı tedarik zinciri | Ele geçirilmiş relay | Özetle sabitlenmiş taban, SBOM, kaynak kanıtı, CodeQL | Relay zaten güvenilmeyen taraftır; etkisi S16 modeliyle sınırlı. |
| R3-12 | Dependabot ana sürüm yükseltmeleri | CI'ın sessizce davranış değiştirmesi | Tek tek inceleme | — |
| R3-13 | Telefon üst sınırı alanının (`agentHigh`) kötüye kullanımı | Sahte yüksek değerle ajanın gereksiz yere kilitlenmesi (hizmet engelleme) | Alan imzalı telefon mesajında taşınır. Yalnızca roster'daki telefonlar gönderebilir. Etki "taban = şimdi"dir: veri kaybı veya yetki kazancı değil. | Ele geçirilmiş sahip telefon gereksiz kilit yaratabilir. |

## 5. Test Senaryoları

| ID | Senaryo | Aşama | Ortam |
|---|---|---|---|
| T3-01 | Yanlış anahtarla açılıştan sonra veritabanı dosyası silinebilir | A0 | Windows CI |
| T3-02 | Dart: onay özeti, vektör bağlamının tamamıyla birebir aynı | A0 | Dart CI |
| T3-03 | Aynı TOTP kodu ikinci kez reddedilir; daha eski adımın kodu reddedilir | A1 | Linux + PG |
| T3-04 | Aynı kodla eşzamanlı iki girişten yalnızca biri kabul edilir | A1 | Linux + PG |
| T3-05 | Docker: imaj derlenir; kök olmayan kullanıcı; `/healthz`; migration; WSS; veritabanı portu dışarıdan kapalı | A2 | CI (Docker) |
| T3-06 | Kasa v2: başka kullanıcı veya makine AAD'si ile açma reddedilir; bozulmuş dosya reddedilir | A3 | Linux + Windows CI |
| T3-07 | DPAPI: gerçek `CryptProtectData` ile sarma/açma; başka kullanıcı bağlamında açılamaz | A3 | Windows CI |
| T3-08 | Sprint 2 kasasından v2'ye geçiş; geçiş yarıda kesilirse veri kaybı yok | A3 | Windows CI |
| T3-09 | Üretim modunda güvensiz kasa seçilirse ajan başlamaz | A3 | Linux + Windows CI |
| T3-10 | TPM yolu yazılımsal KSP ile; TPM yokken politika "zorunlu" ise başlamama | A4 | Windows CI |
| T3-11 | Gerçek TPM: sarma/açma; dosyalar başka makineye kopyalanınca açılamaz | A4 | **Gerçek cihaz** |
| T3-12 | Her yazım noktasında süreç öldürme: açılışta yanlış kilit yok, geri yükleme kaçırılmıyor | A5 | Linux + Windows CI |
| T3-13 | Telefon üst sınırı: veritabanı + kasa birlikte geri yüklenir; telefon bağlanınca geri yükleme tespit edilir | A5 | Linux + Windows CI |
| T3-14 | Replay penceresi özellik testleri | A5 | Linux CI |
| T3-15 | Tüketilmiş onay, geri yüklemeden sonra kabul edilmez | A5 | Linux + Windows CI |
| T3-16 | İptal edilen telefonun açık Noise oturumu anında kapanır | A6 | Gerçek relay + PG |
| T3-17 | İptalden önce imzalanıp kuyrukta bekleyen mesajlar reddedilir | A6 | Gerçek relay + PG |
| T3-18 | İptal edilmiş kimlik veya anahtarla yeniden ekleme reddedilir (her iki kombinasyon) | A6 | Protokol + ajan |
| T3-19 | Relay'de devre dışı cihazın WSS bağlantısı kapanır; token yenilenemez | A6 | Gerçek relay + PG |
| T3-20 | Relay iptal girişini düşürür: etki ölçülür (S23) | A6 | Gerçek relay + PG |
| T3-21 | Toplu teslimin ortasında kopma, relay yeniden başlatma, `ack` öncesi çökme, çift teslim | A7 | Gerçek relay + PG |
| T3-22 | Rastgele kesinti dizileri: en fazla bir kez çalışma, en az bir kez teslim | A7 | Gerçek relay + PG |
| T3-23 | Yol hileleri: junction, sembolik link, UNC, `\\?\`, ADS, 8.3, sondaki nokta/boşluk, yasaklı kökler, TOCTOU | A8 | **Windows CI** (gerçek dosya sistemi) |
| T3-24 | Yetenek kapalıyken araç reddedilir; yerel doğrulama olmadan yetenek açılamaz | A8 | Linux + Windows CI |
| T3-25 | `critical` adım onaysız çalışmaz; yanlış imzacı, süresi dolmuş, tekrar kullanılan veya parametresi değiştirilmiş onay reddedilir | A8 | Gerçek relay + PG |
| T3-26 | `viewer` komut veremez; `operator` kritik onay veremez | A8 | Protokol + ajan |
| T3-27 | Kilit veya yerel engelleme varken onaylı kritik adım bile çalışmaz | A8 | Ajan |
| T3-28 | Relay'den gelen sahte onay ve araç çağrısı reddedilir (S4/S16 regresyonu) | A8 | Gerçek relay + PG |
| T3-29 | Bütün Sprint 1–2 testleri (166 test + Pester) yeşil kalır | Her aşama | Linux + Windows CI |

## 6. Kabul Ölçütleri

**Sprint düzeyi**
1. GitHub CI'daki **bütün işler yeşil**: Linux, Windows, Dart, Pester, Docker, gitleaks, CodeQL.
2. Sprint 1–2'nin hiçbir testi silinmedi veya zayıflatılmadı. Kapsama eşikleri düşürülmedi.
3. T3-01…T3-29'un her biri ya geçti ya da raporda nedeniyle birlikte "kaldı" veya "gerçek cihaz bekliyor" olarak gösterildi.
4. `SECURITY.md` kontrol tablosu güncellendi. Bir kontrol yalnızca testi geçtiyse ilerletildi. Gerçek cihaz gerektiren hiçbir kontrol ✅ yapılmadı.
5. Her aşama ayrı commit'lendi ve yedek noktası bırakıldı.

**Aşama düzeyi**

| Aşama | Kabul ölçütü |
|---|---|
| A0 | Windows ve Dart işleri yeşil |
| A1 | T3-03, T3-04 |
| A2 | T3-05; imaj taraması ciddi açık göstermiyor ya da gösterdiği açıklar raporda listelenmiş |
| A3 | T3-06…T3-09. Dönem artışında DPAPI çağrısı yok; ölçülen yazım süresi raporda. |
| A4 | T3-10; araştırma ADR'si yazıldı; T3-11 gerçek cihaz test planında |
| A5 | T3-12…T3-15 |
| A6 | T3-16…T3-20 |
| A7 | T3-21, T3-22 |
| A8 | T3-23…T3-28. S8 kontrolü 🟨 (Windows CI'da testli; gerçek cihazda bekliyor). |
| A9 | Docker işi CI'da; yayın iş akışı en az bir kez başarıyla çalıştı; Dependabot istekleri karara bağlandı |
| A10 | Test kiti Windows CI'da kuru çalıştırmayla geçiyor; plan belgesi hazır |

## 7. Gerçek Cihaz Test Planı

**Önemli:** Bu sprintte gerçek cihaz testlerini ben yürütemem. Kiti ve planı hazırlarım. Testi siz veya BT yürütür ve sonuç raporunu paylaşır. Rapor gelene kadar ilgili maddeler "gerçek cihazda doğrulanmadı" olarak kalır.

### 7.1 Windows (hedef: en az bir şirket bilgisayarı + bir kişisel bilgisayar)

| Adım | İçerik | Sonuç kaydı |
|---|---|---|
| W0 | Ön bilgi: Windows sürümü, alan üyeliği, TPM (`tpm.msc` / `Get-Tpm`), AV/EDR ürünü, PowerShell dil modu | Envanter betiği (D6) |
| W1 | Envanter betiğinin hedef makinede çalıştırılması (D6, hâlâ bekliyor) | JSON |
| W2 | Test kitinin kurulumu (yönetici yetkisi **gerektirmeyen** mod) | EDR uyarısı oldu mu? |
| W3 | DPAPI kasası: oluşturma, yeniden başlatma sonrası açma, başka kullanıcıyla açamama | Geçti/kaldı |
| W4 | TPM: sarma/açma; kasa dosyalarını başka bir makineye kopyalayıp açamama | Geçti/kaldı |
| W5 | Rollback: veritabanı dosyasının eski kopyasını geri koyma → tespit | Geçti/kaldı |
| W6 | Yol doğrulama: geçici klasörde junction ve kısa ad; ağ sürücüsü (UNC) reddi | Geçti/kaldı |
| W7 | Relay'e giden bağlantı: şirket proxy'si ve güvenlik duvarı arkasından 443 | Gecikme, hata |
| W8 | Uyku/uyanma ve ağ değişimi sonrası yeniden bağlanma | Süre |
| W9 | (İsteğe bağlı, K3'e bağlı) TPM NV sayacı prototipi; yönetici yetkisiyle | Süre, hata |

**Kurallar:** Kit hiçbir şirket dosyasını okumaz. Yalnızca kendi oluşturduğu geçici klasörü kullanır, ASEDEN'e bağlanmaz ve sonunda kendini temizler. Rapor; kullanıcı adı, makine adı ve yol bilgilerinden arındırılır.

### 7.2 Android
- Android uygulaması S4'tedir. Bu sprintte telefonda çalıştırılabilecek bir uygulama **yoktur**.
- S3'te yapılacak: Dart vektör testinin GitHub CI'da yeşile çekilmesi (A0). Ardından S4'te kullanılacak cihaz matrisi belirlenir: en az bir Android 13+ cihazı (StrongBox varsa), bir eski ama desteklenen cihaz ve iş profili/MDM'li bir cihaz (şirket politikası gerektiriyorsa).
- Sizden S4 başlamadan önce istenen: test için kullanılacak telefon modelleri ve şirketin MDM kullanıp kullanmadığı.

### 7.3 Relay
- Gerçek sunucu kurulumu S5'tedir (kişisel VPS + şirket DMZ). S3'te yalnızca CI'daki Docker testi yapılır. Bu, gerçek bir sunucuda çalıştığı anlamına **gelmez**.

## 8. Onayınızı Bekleyen Kararlar

| # | Karar | Önerim |
|---|---|---|
| **K1** | 13 haftalık planın etkisi | **K1-A:** S3 sağlamlaştırma (3 hf) + S3b araçlar (2 hf) ≈ 16 hafta |
| **K2** | DPAPI/TPM erişim yolu | **K2-A:** Kendi küçük N-API eklentimiz |
| **K3** | TPM NV sayacı (yönetici yetkisi gerektirebilir) | S3'te yalnızca prototip ve ölçüm. Üretim kararı gerçek cihaz testinden sonra. |
| **K4** | CD kapsamı | GHCR'ye imaj + SBOM + kaynak kanıtı. Sunucuya **otomatik dağıtım yok.** |
| **K5** | `main` dal koruması | Açılması (sizin repo ayarlarınızdan) |

Onayınızla birlikte A0'dan başlarım. Her aşamadan sonra CI sonucunu kontrol eder, kırmızıysa bir sonrakine geçmem.
