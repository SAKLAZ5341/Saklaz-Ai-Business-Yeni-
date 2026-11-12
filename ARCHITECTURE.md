# SAKLAZ AI — Teknik Mimari

> **Sürüm:** v0.3, 2026-11-12 (proje sahibi onayı: çok cihazlı, her yerden erişilebilir platform; PERSONAL ve BUSINESS alanları)
> **Durum:** Onaylı tasarım. Uygulama durumu için bkz. ROADMAP.md ve sprint raporları.
> Güvenlikle ilgili her ifade SECURITY.md §0'daki varsayımlar altında geçerlidir; hiçbiri mutlak değildir.
> Değişiklikler en altta, §12 ve §13'te listelenmiştir. v0.3'ün ayrıntılı gerekçesi: docs/MIMARI-v0.3-ONERI.md.

## 1. Amaç ve Kapsam

SAKLAZ AI; telefondan, dünyanın her yerinden, birden çok bilgisayara ve yetki verilen sistemlere güvenli erişim sağlayan, modüler ve çoklu ajanlı bir kişisel ve kurumsal platformdur. Üç parçadan oluşur:

- Her bilgisayarda çalışan bir **ajan**. Her ajan tek bir çalışma alanına aittir.
- Android (Flutter) mobil uygulama. Tek uygulama içinde PERSONAL ve BUSINESS alanları bulunur; anahtarlar, oturumlar, bildirim içerikleri ve veriler bu alanlar arasında ayrıdır.
- Her çalışma alanı için ayrı bir **aktarım (relay) sunucusu**:
  - PERSONAL: proje sahibinin kontrolündeki VPS.
  - BUSINESS: şirket içi DMZ sanal makinesi.

ASEDEN ERP ile **bağımsız ve varsayılan olarak salt okunur** bir connector üzerinden entegre olur. ASEDEN'in kaynak koduna, veritabanı şemasına veya çalışan sistemine hiçbir değişiklik yapılmaz.

## 2. Bağlayıcı Tasarım Kuralları

Bu kurallar proje sahibinin talimatıdır. Hiçbir tasarım veya kod kararı bunları ihlal edemez.

| # | Kural | Mimarideki karşılığı |
|---|---|---|
| K1 | ASEDEN verileri ve şirket dosyaları izinsiz buluta gönderilmez. | Veri yalnızca Windows ajanında işlenir. Dış AI sağlayıcıları varsayılan olarak kapalıdır (§6). |
| K2 | Merkezi sunucu yalnızca bağlantı, görev yönlendirme ve cihaz yönetimi yapar. | Sunucu bir "kör aktarıcıdır": içerik görmez, içerik saklamaz (§3.1). |
| K3 | Dosya içerikleri Windows bilgisayarında işlenir. | Tüm araçlar ajan içinde çalışır. Sunucuda dosya işleme kodu yoktur. |
| K4 | Telefon ile Windows arasında güvenli ve şifreli iletişim kurulur. | Uçtan uca şifreleme (E2EE). Anahtarlar eşleştirmede doğrudan cihazlar arasında, QR ile değiştirilir (SECURITY.md §4–5). |
| K5 | Merkezi sunucu ele geçirilse bile kritik işlem yaptıramaz. | Ajan yalnızca eşleştirilmiş telefonun imzaladığı komutları çalıştırır. Sunucunun imza anahtarı yoktur (SECURITY.md §3). |
| K6 | Telefon onayları kriptografik olarak doğrulanır. | Ed25519 imzası, parametre özeti, tek kullanımlık ve süreli onay (SECURITY.md §7). |
| K7 | Sunucu şirket onaylı ve mümkünse şirketin kendi kontrolünde olur. | Kendi sunucunda (self-hosted) Docker Compose dağıtımı. Üçüncü taraf bulut servisi zorunlu değildir (§8). |
| K8 | Canlı ASEDEN verisi değiştirilmez. | Connector'da yazma yolu yoktur. Keşif yalnızca katalog düzeyinde ve salt okunurdur (docs/discovery). |
| K9 | PERSONAL ve BUSINESS alanları ayrı anahtar, ayrı sunucu, ayrı kayıt ve ayrı yetkilerle çalışır. | §3A.1; SECURITY.md §17 |
| K10 | Yeni cihaz yalnızca QR eşleştirmesi ve donanım destekli biyometrik anahtarla imzalanmış sahip onayıyla eklenir. Biyometri ham verisi hiçbir sunucuya gönderilmez; biyometrik eşleştirme yalnızca telefonun işletim sistemi içinde yapılır. | §3A.2; SECURITY.md §18 |
| K11 | Üç katmanlı kurtarma uygulanır: yedek cihaz, kağıt kurtarma ifadesi (72 saatlik zaman kilidi) ve yerel kurtarma. | §3A.3; SECURITY.md §19 |
| K12 | Alanlar arası dosya aktarımı Faz 1'de bulunmaz. | Faz 2 |
| K13 | Eski yedeğin geri yüklenmesi komutların tekrar çalışmasına yol açmamalıdır. İptal edilmiş cihazın anahtarları yeniden kullanılamaz. Telefon–bilgisayar güven ilişkileri ayrı ayrı yönetilir. | SECURITY.md §18, §20 |
| K14 | Güvenlik garantileri mutlak veya koşulsuz olarak ifade edilmez. | SECURITY.md §0 |

## 3. Üst Düzey Mimari

```
                       Şirket kontrolündeki sunucu (self-hosted)
                       ┌──────────────────────────────────────────┐
                       │  SAKLAZ Relay (Node.js + TypeScript)     │
                       │  - Hesap girişi + MFA (yalnız erişim)    │
                       │  - Cihaz kaydı (yalnız açık anahtarlar)  │
                       │  - Şifreli mesaj yönlendirme / kuyruk    │
                       │  - Çevrimiçi durumu, push tetikleme      │
                       │  - Meta veri denetim kaydı               │
                       │  İÇERİK GÖRMEZ · İMZA ANAHTARI YOK       │
                       └──────▲───────────────────────▲───────────┘
            WSS (TLS 1.3)     │                       │   WSS (TLS 1.3), yalnızca GİDEN bağlantı
          ┌───────────────────┘                       └──────────────────────┐
┌─────────┴────────────┐                                       ┌─────────────┴──────────────────────┐
│ Android (Flutter)    │ ═══ Uçtan uca şifreli kanal (Noise) ══│ Windows: SAKLAZ Agent Servisi      │
│ - Komut (imzalı)     │     Sunucu yalnızca şifreli metni     │ - İmza doğrulama, politika motoru  │
│ - Onay (biyometrik + │     iletir                            │ - Orkestratör + uzman ajanlar      │
│   Ed25519 imza)      │                                       │ - Araçlar (dosya, Office, PDF)     │
│ - Görev geçmişi      │                                       │ - Yerel audit (hash zinciri)       │
│ Android Keystore     │                                       │ - DPAPI kasası, SQLite             │
└──────────────────────┘                                       └───────┬───────────────┬────────────┘
                                                        named pipe     │               │ yerel ağ, salt okunur
                                                        (yalnız yerel  ▼               ▼
                                                         kullanıcı)  Masaüstü UI     ASEDEN ERP
                                                                     (Electron)      (keşif sonrası)
```

### 3.1 Sunucu neyi bilir, neyi bilmez?

Tasarım hedefi aşağıdaki gibidir; SECURITY.md §0'daki varsayımlar altında geçerlidir.

| Sunucu **bilir** (meta veri) | Sunucu **bilmez** |
|---|---|
| Hesap e-postası, MFA durumu | Komut metinleri |
| Cihaz kimlikleri ve açık anahtarları | Dosya içerikleri, dosya adları, rapor içerikleri |
| Hangi cihazın ne zaman çevrimiçi olduğu | ERP verisi |
| Mesajların zamanı, boyutu, gönderen/alıcı cihaz | Onayın hangi işlem için verildiği |
| İmzalı cihaz listesinin şifreli kopyası (saklar ve dağıtır, ancak giriş üretemez) | Diğer çalışma alanının **hiçbir verisi**: her alanın ayrı relay'i vardır |
| Görev kimliği ve kaba durumu (ör. `running`) | Görev başlığı, parametreleri, sonucu |

Görev başlıkları dahil tüm içerik şifreli taşınır. Sunucudaki görev kaydı yalnızca kimlik, uç noktalar, zaman damgaları ve şifreli olmayan kaba durumdan oluşur.

### 3.2 Görev akışı (uzaktan komut)

1. Kullanıcı telefonda komut yazar. Telefon komutu kendi Ed25519 anahtarıyla **imzalar** ve E2EE oturumuyla **şifreler**.
2. Sunucu şifreli zarfı hedef Windows cihazına iletir. Cihaz çevrimdışıysa zarfı süreli kuyrukta tutar (varsayılan 24 saat).
3. Ajan zarfın şifresini çözer ve imzayı **eşleştirmede sabitlenmiş** telefon anahtarıyla doğrular. Ardından zaman damgası ve sayaçla tekrar oynatma (replay) kontrolü yapar.
4. Ajan görevi planlar. AI izinliyse yerel modelle, değilse kural ve şablonlarla planlar. Her adım politika motorundan geçer.
5. `critical` bir adım varsa ajan şifreli bir onay isteği gönderir. Telefon işlemin ayrıntılarını gösterir. Kullanıcı biyometrik doğrulama sonrası onaylar ve telefon onayı imzalar. Ajan onayı doğrulamadan adımı çalıştırmaz.
6. Ajan sonuçları yerelde saklar ve telefona şifreli bir özet gönderir. Tam dosya yalnızca kullanıcı telefondan açıkça isterse aktarılır (§3.3).
7. Her adım Windows'taki hash zincirli yerel denetim kaydına yazılır. Sunucu yalnızca meta veri olaylarını kaydeder.

### 3.3 Dosya ve rapor aktarımı

- Varsayılan: Telefon raporun **özetini** görür (ör. ilk satırlar, toplamlar).
- Telefonda tam dosyayı görmek, kullanıcının o dosya için açık talebiyle olur. Dosya, ajan tarafından 64 KB'lık parçalara bölünür. Her parça E2EE ile şifrelenir. Sunucu parçaları yalnızca iletir; telefon çevrimdışıysa süreli olarak (varsayılan 24 saat) şifreli tutar ve sonra siler.
- Organizasyon politikasıyla "dosya cihaz dışına çıkamaz" modu açılabilir. Bu modda yalnızca özet gönderilir.

## 3A. Çalışma Alanları, Cihaz Listesi ve Kurtarma (v0.3)

### 3A.1 Çalışma alanları

```
                    ┌──────────────────────── TELEFON (tek uygulama) ──────────────────────┐
                    │  PERSONAL: komut + onay + DH anahtarları,  │  BUSINESS: ayrı anahtarlar,│
                    │  ayrı yerel DB, ayrı oturumlar, ayrı FCM   │  ayrı DB, ayrı FCM;        │
                    │                                            │  MDM varsa onun kuralları  │
                    └──────────────┬─────────────────────────────┴──────────────┬─────────────┘
                                   │ E2EE                                        │ E2EE
                    ┌──────────────▼──────────────┐              ┌───────────────▼─────────────┐
                    │ PERSONAL relay (kişisel VPS)│              │ BUSINESS relay (şirket DMZ) │
                    └──────────────┬──────────────┘              └───────────────┬─────────────┘
                    ┌──────────────▼──────────────┐              ┌───────────────▼─────────────┐
                    │ Ev bilgisayarı + ileride    │              │ Şirket bilgisayarı + ileride│
                    │ diğer kişisel bilgisayarlar │              │ diğer kurumsal bilgisayarlar│
                    └─────────────────────────────┘              └─────────────────────────────┘
```

- Her mesajın imzalı başlığında `ws` (alan kimliği) bulunur. Ajan, kendi alanına ait olmayan mesajı reddeder.
- Onay özeti de `ws` alanını kapsar.
- Aynı bilgisayar iki alanda kullanılacaksa, iki ayrı Windows kullanıcı hesabında iki ayrı ajan kurulur.

### 3A.2 İmzalı cihaz listesi ve cihazlar arası güven bağları

- Her alanda, sahip telefonların onay anahtarıyla imzalanan, hash zincirli ve yalnızca ekleme yapılabilen bir liste tutulur (`packages/protocol/src/roster.ts`).
- **İşlemler:**
  - `genesis`
  - `device.add` (eklenen cihazın eş-imzası zorunlu)
  - `device.revoke` (cihazı ve anahtarlarını kalıcı yasak listesine ekler)
  - `link.set` / `link.remove`: telefon–bilgisayar çifti başına rol (owner/operator/viewer)
- Ajan, bir telefonun yetkisini **o telefon ile kendisi arasındaki bağdan** okur.
- Her mesaj gönderenin bildiği liste başını (`rh`) taşır. Ajanın listesi daha eskiyse mesaj, eksik girişler gelene kadar işlenmez.

### 3A.3 Kurtarma ve geri yükleme

- **Kurtarma katmanları** (ayrıntı: SECURITY.md §19; uygulama Sprint 6):
  1. Yedek sahip cihaz
  2. Kağıt kurtarma ifadesi (72 saatlik zaman kilidi; süre, isteğin her bilgisayarda yerel olarak ilk görüldüğü andan başlar)
  3. Yerel kurtarma
- **Geri yükleme koruması** (SECURITY.md §20): Veritabanının dışında tutulan monoton bir durum dönemi sayesinde, eski bir yedeğin geri yüklendiği tespit edilir. Geri yükleme anından önceki mesajlar reddedilir.

### 3A.4 Bilgisayarların ve sistemlerin yetkileri

Her bilgisayarın yetenekleri (dosya, uygulama, tarayıcı, ERP, e-posta) **o bilgisayarda yerel olarak** açılır. Telefon yalnızca bağı olan bilgisayarlara ve o bilgisayarda açık olan yeteneklere komut verebilir. "Tüm bilgisayarlara aynı anda" komutu bilinçli olarak yoktur.

## 4. Bileşenler

### 4.1 Relay Sunucu (`apps/relay`)

| Modül | Sorumluluk |
|---|---|
| `auth` | Hesap girişi (Argon2id), TOTP MFA, kısa ömürlü erişim token'ı ve dönen refresh token. **Yalnızca relay'e erişim yetkisi verir; komut yetkisi vermez.** |
| `devices` | Cihaz kaydı, açık anahtar dizini, iptal listesi. Ajan bu dizine güvenmez; anahtarlar eşleştirmede sabitlenir. |
| `relay` | WSS oturumları, şifreli zarf yönlendirme, süreli çevrimdışı kuyruk, akış denetimi (backpressure). |
| `presence` | Çevrimiçi/çevrimdışı durumu, heartbeat. |
| `push` | Push bildirimini içeriksiz "yeni olay var" sinyali olarak tetikler (§8.3). |
| `audit` | Meta veri denetim kaydı (append-only, hash zinciri). |
| `admin` | Kullanıcı ve cihaz yönetimi, kota ve rate-limit ayarları. |

Relay'de iş mantığı, dosya işleme, AI çağrısı veya ERP bağlantısı **bulunmaz**. Bu bilinçli bir sınırdır: ele geçirilmesi durumunda saldırı yüzeyini ve sızacak bilgiyi en aza indirir.

### 4.2 Windows Agent Servisi (`apps/agent`)

- Kullanıcı oturumu düzeyinde çalışan bir Node.js sürecidir. SYSTEM yetkisiyle çalışmaz. Oturum açılışında başlar.
- **Taşıma (transport):** Relay'e giden WSS bağlantısı, Noise oturumları, yeniden bağlanma ve outbox.
- **Doğrulayıcı (verifier):** İmza, replay ve süre kontrolü. Doğrulanmamış hiçbir mesaj orkestratöre ulaşamaz.
- **Orkestratör:** Görevi adımlara böler ve uzman ajanlara yönlendirir.
- **Araç katmanı:** Her araç şunları bildirir: ad, zod giriş şeması, risk seviyesi (`read` / `write` / `critical`) ve gerekli izinler.
- **Politika motoru:** Klasör allowlist'i, risk seviyesinden onay gereksinimine eşleme, rate limit ve veri sınıfı kuralları (DataGuard).
- **Yerel depo:** SQLite. Gizli bilgiler DPAPI / Windows Credential Manager'da tutulur.

### 4.3 Masaüstü UI (`apps/desktop`)

- Electron + React ile yazılır. Ajanla yalnızca ACL'li named pipe üzerinden konuşur.
- Renderer sürecinde Node erişimi kapalıdır; katı CSP uygulanır.
- **Ekranlar:** Sohbet, Görevler, Ajanlar, Onaylar, Bildirim Merkezi, İşlem Geçmişi, Sistem Durumu, İzinler, Eşleştirilmiş Cihazlar.
- **Görünüm:** Koyu tema, lacivert ve mavi palet, sol navigasyon menüsü.
- Masaüstünden verilen komutlar yerel kullanıcı oturumuyla yetkilidir. `critical` işlemler için Windows Hello ile yerel onay alınır.

### 4.4 Android Uygulaması (`apps/mobile`)

- **Uygulama altyapısı:** Flutter 3, Riverpod, Dio.
- **Bildirim:** Push sağlayıcısı (§8.3).
- **Güvenlik:** `local_auth` ile biyometrik doğrulama. Anahtarlar Android Keystore'da, mümkünse StrongBox'ta tutulur. İmza anahtarının kullanımı biyometrik doğrulamaya bağlıdır.
- **Kriptografi:** Mobil taraf, Windows ajanıyla aynı primitifleri kullanır (X25519, Ed25519, ChaCha20-Poly1305). Kriptografi uygulaması kendimiz yazılmaz; denetlenmiş bir libsodium bağlaması kullanılır. Hangi bağlamanın seçileceği Faz 1 başında bir ADR ile belirlenecek.
- **Uyumluluk:** Uyumluluk test vektörleriyle (`packages/protocol/test-vectors`) sürekli doğrulanır.

### 4.5 ASEDEN ERP Connector (`packages/erp-core`, `packages/erp-aseden`)

- Ajan içinde, yerel ağda çalışır. ERP verisi relay'e uğramaz.
- **`ErpConnector` arayüzü** şu salt okunur yöntemleri içerir:
  - `listPurchaseRequests`
  - `listQuotes`
  - `listOrders`
  - `listSuppliers`
  - `getStock`
  - `listAs9100Records`
  - `runReport`
- **Veritabanı motoru henüz doğrulanmadı.** PostgreSQL'e geçildiği, Firestore'un artık kullanılmadığı belirtildi; ancak canlı ortamda teyit edilmedi. Bu doğrulama yapılmadan `erp-aseden` paketine bağlantı kodu yazılmaz. Keşif planı ve entegrasyon seçenekleri için bkz. `docs/discovery/ASEDEN-KESIF.md`.
- Testlerde `MockErpConnector` kullanılır. Bu connector'ın döndürdüğü her kayıt `source: "mock"` taşır ve UI'da "DEMO VERİ" olarak etiketlenir.
- Yazma işlemleri ileride ayrı bir paket (`erp-aseden-write`) olarak eklenir. Bu paket ayrı kimlik bilgisi kullanır ve her işlem için zorunlu telefon onayı ister.

### 4.6 Uzman Ajanlar (`packages/agents/*`)

| Ajan | Araçlar | Faz |
|---|---|---|
| Excel ve Raporlama | Dosya okuma, xlsx okuma ve yazma, docx/pdf oluşturma | MVP |
| Kişisel Asistan | Dosya arama, özetleme | MVP (temel) |
| Satınalma | ERP (salt okunur), raporlama | Faz 2 |
| AS9100 Kalite | ERP, belge okuma, kontrol listeleri | Faz 2 |
| Yönetim Raporlama | ERP ve Excel ajanlarının çıktıları | Faz 2 |
| E-posta | Outlook (sürüm ve yöntem sonra belirlenecek) | Faz 3 — **MVP dışı** |
| Bilgisayar Kontrol | Uygulama açma, tarayıcı, ekran yardımı | Faz 3 |

## 5. Ajan Çalışma Modeli

```ts
interface AgentDefinition {
  key: string;                  // "reporting", "purchasing", ...
  description: string;
  tools: ToolKey[];             // izin verilen araçların kapalı listesi
  dataClasses: DataClass[];     // dokunabileceği veri sınıfları
  rules: RulePlan[];            // AI yokken çalışacak kural tabanlı planlar
  systemPrompt?: string;        // AI varsa
}

interface Tool<I, O> {
  key: ToolKey;
  risk: "read" | "write" | "critical";
  input: ZodSchema<I>;
  requires: Permission[];       // ör. folder.read:<grantId>
  run(input: I, ctx: ToolContext): Promise<O>;
}
```

- Ajanlar dünyaya yalnızca araçlar üzerinden dokunabilir.
- Araçları çağıran şey her zaman politika motorudur, model değildir. Model yalnızca öneride bulunur; politika motoru izin verir veya reddeder.

## 6. AI Katmanı (`packages/ai`)

```ts
interface AIProvider {
  id: string;
  locality: "local" | "external";
  capabilities: { tools: boolean; vision: boolean };
  chat(req: ChatRequest, opts: { signal: AbortSignal }): Promise<ChatResponse>;
}
```

- **Varsayılan yapılandırma** (K1 gereği):
  - Dış sağlayıcı kapalıdır.
  - Yerel model (Ollama vb.) isteğe bağlıdır.
  - AI yoksa `RuleEngine` çalışır.
- **Dış sağlayıcı kullanımı:** Bir dış sağlayıcı (Anthropic, OpenAI uyumlu vb.) yalnızca organizasyon yöneticisi tarafından, belirli veri sınıfları için açıkça etkinleştirilebilir. `confidential` sınıfı (ERP, AS9100, müşteri verisi, şirket dosyaları) dış sağlayıcıya gönderilemez. Bu kuralı değiştirmek bir yapılandırma ayarıyla değil, kod değişikliği ve ADR ile mümkündür.
- **DataGuard:** Her istek öncesi çalışır ve politika dışı içeriği engeller. Engellenen istekler denetim kaydına yazılır.
- **Güvenilmez içerik:** Dosya, e-posta, web ve ERP içeriği modele "güvenilmez veri" bloklarında verilir. Model ne onay adımını atlayabilir ne de izinleri genişletebilir.

## 7. Teknoloji Seçimleri ve Gerekçeleri

| Alan | Seçim | Gerekçe | Değerlendirilen alternatif |
|---|---|---|---|
| Dil | TypeScript (strict) | Talep edildi. Relay, ajan ve masaüstü ortak tip ve şemayı paylaşır. | — |
| Monorepo | pnpm workspaces + Turborepo | Paylaşılan paketler, önbellekli build. | Nx |
| Relay | Node.js 22 LTS + Fastify + `ws` | Hafif, şema tabanlı doğrulama, tam protokol kontrolü. | NestJS, Socket.IO |
| Relay DB | PostgreSQL 16 | Self-hosted'da olgun, yedeklemesi kolay. | — |
| ORM | Drizzle | SQL'e yakın, şeffaf migration. | Prisma |
| Kuyruk | PostgreSQL tabanlı (pg-boss) | Ek altyapı gerektirmez. | Redis/BullMQ (ölçek gerekirse) |
| E2EE | Noise Protocol (`Noise_KK_25519_ChaChaPoly_BLAKE2b`; ADR-0008: libsodium BLAKE2s içermez) + Ed25519 uygulama imzaları | İleri gizlilik (forward secrecy), karşılıklı kimlik doğrulama, iyi analiz edilmiş bir çerçeve. | TLS mTLS (sunucuda sonlanır, K4'ü sağlamaz); Signal protokolü (çoklu cihaz grupları için fazla karmaşık) |
| Kripto kütüphanesi | libsodium (JS: `libsodium-wrappers-sumo`, Dart: denetlenmiş bağlama) | Denetlenmiş, iki platformda da var. | WebCrypto (Ed25519/X25519 desteği platforma göre değişken) |
| Doğrulama | zod | Tüm sınır noktalarında aynı şema. | — |
| Masaüstü | Electron + React + Vite | TypeScript gereksinimi. | Tauri (Rust gerektirir) |
| Office/PDF | ExcelJS, mammoth, docx, pdfjs-dist, pdfkit | Office kurulumu gerektirmez, tamamen yerel çalışır. | Office COM (kırılgan) |
| Yerel DB | better-sqlite3 | Gömülü. | — |
| Mobil | Flutter 3 + Riverpod | Talep edildi. | — |
| Test | Vitest, Playwright, flutter_test, çapraz platform kripto test vektörleri | — | Jest |
| Dağıtım | Docker Compose (relay), electron-builder + kod imzalama | Self-hosted için basit ve tekrarlanabilir. | Kubernetes (gereksiz) |

## 8. Dağıtım ve Barındırma

### 8.1 Seçenekler

| Seçenek | Açıklama | Artı | Eksi |
|---|---|---|---|
| **A. Şirket içi VM + 443 yayını (önerilen)** | Şirketin sanal makinesi. Önünde ters vekil sunucu (Caddy/Nginx) var ve yalnızca 443 portu dışarı açık. | Tam kontrol. Telefon her yerden bağlanır. | Bir portun internete açılması ve IT onayı gerekir. |
| B. Şirket içi VM + yalnız VPN (WireGuard) | Relay internete hiç açılmaz. Telefon VPN üzerinden bağlanır. | En küçük saldırı yüzeyi. | Telefonda VPN yönetimi gerekir; kullanım zorlaşır. |
| C. Şirket hesabındaki VPS (yurt içi sağlayıcı) | Şirket adına kiralanmış sunucu. | Kurulumu kolaydır. Ağ IT'den bağımsızdır. | Fiziksel kontrol sağlayıcıdadır. E2EE sayesinde içerik yine okunamaz. |

E2EE sayesinde üç seçenekte de relay yalnızca meta veri görür. Seçim, IT politikasına ve müşteri gereksinimlerine göre yapılmalıdır (ör. savunma sanayii müşterilerinin veri yerleşimi şartları). **Karar proje sahibine aittir** (bkz. docs/FAZ0-RAPOR.md).

### 8.2 Relay sunucu gereksinimleri

| Kalem | Gereksinim |
|---|---|
| İşletim sistemi | Linux (Ubuntu 24.04 LTS veya Debian 12), 2 vCPU, 4 GB RAM, 40 GB disk. 50 cihaza kadar yeterli tahmin; Faz 1'de yük testiyle doğrulanacak. |
| Yazılım | Docker Engine + Compose. |
| Alan adı ve sertifika | Alan adı ve TLS sertifikası (Let's Encrypt veya şirket CA). |
| Yedekleme | Relay DB için günlük yedekleme. Relay içerik saklamadığından yedek küçük ve düşük hassasiyetlidir. |

### 8.3 Push bildirim

- Android'de güvenilir arka plan bildirimi pratikte Firebase Cloud Messaging (FCM) üzerinden yapılır. FCM bir Google servisidir.
- K1 ile uyum için FCM'e yalnızca **içeriksiz uyandırma sinyali** gönderilir. Bu sinyal görev adı, kullanıcı verisi ve şirket verisi taşımaz. İçerik, uygulama açıldığında E2EE kanaldan çekilir.
- FCM'in hiç kabul edilmediği durumlar için alternatif: uygulama açıkken WSS bağlantısı ve kendi barındırılan UnifiedPush/ntfy sunucusu. Bu yol, pil ve teslim güvenilirliği açısından dezavantajlıdır.
- **Karar proje sahibine aittir.**

## 9. Klasör Yapısı

```
saklaz-ai/
├── ARCHITECTURE.md  ROADMAP.md  SECURITY.md  README.md
├── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├── .github/workflows/            # lint, typecheck, test, gitleaks, CodeQL
├── docs/
│   ├── FAZ0-RAPOR.md             # Faz 0 sonuç raporu
│   ├── REQUIREMENTS.md           # Teknik gereksinimler
│   ├── RISKS.md                  # Risk kaydı
│   ├── adr/                      # Mimari karar kayıtları
│   └── discovery/                # ASEDEN ve Windows keşif belgeleri
├── tools/discovery/              # Salt okunur keşif betikleri
├── apps/
│   ├── relay/                    # Relay sunucu
│   ├── agent/                    # Windows ajan servisi
│   ├── desktop/                  # Electron UI
│   └── mobile/                   # Flutter
├── packages/
│   ├── protocol/                 # Zarf tipleri, zod şemaları, kripto test vektörleri
│   ├── crypto/                   # Noise oturumu, imza, eşleştirme (libsodium üzerine ince katman)
│   ├── policy/                   # Politika motoru, risk seviyeleri, DataGuard
│   ├── ai/                       # AIProvider, adaptörler, RuleEngine
│   ├── agents/                   # Uzman ajan tanımları
│   ├── tools/                    # Araçlar
│   ├── erp-core/                 # ErpConnector arayüzü + MockErpConnector
│   ├── erp-aseden/               # Keşif doğrulanana kadar BOŞ
│   ├── ui/                       # Paylaşılan React bileşenleri, tema
│   └── config/                   # eslint, tsconfig, vitest ortak ayarları
└── infra/
    ├── docker/                   # docker-compose: relay, postgres, caddy
    └── scripts/
```

## 10. Veritabanı Tasarımı

### 10.1 Relay (PostgreSQL) — yalnızca meta veri

```
users             id uuid PK, email citext UNIQUE, password_hash, display_name,
                  mfa_secret_enc bytea, mfa_enabled bool, status, created_at, last_login_at
organizations     id, name, settings jsonb (politika bayrakları), created_at
memberships       user_id, organization_id, role enum(owner, admin, operator, viewer)
refresh_tokens    id, user_id, token_hash, family_id, expires_at, revoked_at

devices           id uuid PK, organization_id, owner_user_id, kind enum(windows_agent, android),
                  label_enc bytea,                -- cihaz adı da şifreli (yalnız cihazlar okur)
                  sign_pubkey bytea (Ed25519), dh_pubkey bytea (X25519),
                  status enum(active, revoked), created_at, last_seen_at, revoked_at
device_links      phone_device_id, agent_device_id, created_at, revoked_at
                  -- hangi telefon hangi ajana bağlı (yönlendirme için)
pairing_sessions  id, agent_device_id, expires_at (≤5 dk), state, attempts
                  -- eşleştirme sırrını TUTMAZ; sır yalnızca QR'da

envelopes         id uuid PK, from_device_id, to_device_id, kind enum(msg, file_chunk),
                  ciphertext bytea, size int, created_at, expires_at, delivered_at
                  -- çevrimdışı kuyruk; teslimden sonra veya süre dolunca silinir
task_index        id uuid PK (istemcinin ürettiği), organization_id, phone_device_id,
                  agent_device_id, coarse_status enum(sent, delivered, running,
                  awaiting_approval, done, failed), created_at, updated_at
                  -- başlık, parametre, sonuç YOK

audit_meta        id bigserial PK, occurred_at, actor_type, actor_id, organization_id,
                  action, target_type, target_id, ip inet, details jsonb, prev_hash, hash
```

- Uygulama DB kullanıcısının `audit_meta` tablosunda yalnızca `INSERT` ve `SELECT` yetkisi vardır.
- `envelopes` tablosu periyodik olarak temizlenir.

### 10.2 Windows Agent (SQLite) — içeriğin asıl yaşadığı yer

```
identity          sign_privkey_ref, dh_privkey_ref   -- DPAPI korumalı anahtar referansları
paired_devices    device_id, sign_pubkey, dh_pubkey, label, role, paired_at, revoked_at
replay_guard      device_id, last_counter, recent_nonces
folder_grants     id, path, access enum(read, read_write), recursive, granted_at
tasks             id, from_device_id, title, input jsonb, plan jsonb, status, created_at, finished_at
steps             id, task_id, tool_key, risk, input jsonb, output_ref, status, started_at, finished_at
approvals         id, task_id, step_id, params_digest, requested_at, expires_at,
                  decision, signer_device_id, signature, decided_at
audit             id, occurred_at, action, details jsonb, prev_hash, hash
outbox            id, to_device_id, envelope blob, created_at, sent_at
erp_cache         entity, key, data jsonb, fetched_at, ttl   -- Faz 2, salt okunur önbellek
```

### 10.3 Android (yerel, şifreli)

- `paired_agents`, `task_history`, `approval_history` tutulur. Veritabanı SQLCipher ile şifrelenir; anahtarı Keystore'dadır.

## 11. Hata Yönetimi

- Tipli hatalar kullanılır:
  - `ValidationError`
  - `SignatureInvalid`
  - `ReplayDetected`
  - `PermissionDenied`
  - `ApprovalRequired`
  - `ApprovalExpired`
  - `ToolFailure`
  - `ProviderUnavailable`
- Görev adımları idempotent anahtarlarla çalışır.
- Bağlantı koptuğunda zarflar outbox'ta bekler.
- Kriptografik doğrulama hataları hiçbir zaman "yeniden dene" ile geçiştirilmez. Mesaj reddedilir ve denetim kaydına yazılır.
- Kullanıcı mesajları Türkçe ve eyleme dönüktür.

## 12. v0.1 → v0.2 Değişiklikleri

- Merkez sunucu, "kör aktarıcı" (relay) rolüne indirildi (K2).
- Telefon ile Windows arasına uçtan uca şifreleme eklendi. Komutlar da imzalı hale geldi; v0.1'de yalnızca onaylar imzalıydı (K4, K5).
- Sunucuda artifact (dosya) depolama kaldırıldı. Yerine süreli, şifreli parça aktarımı geldi.
- Dış AI sağlayıcıları varsayılan olarak kapatıldı (K1).
- Outlook MVP dışına alındı; yöntemi sonra belirlenecek.
- Self-hosted barındırma seçenekleri ve push bildirim değerlendirmesi eklendi.
- ASEDEN veritabanı "doğrulanmadı" olarak işaretlendi ve keşif planına bağlandı.

## 13. v0.2 → v0.3 Değişiklikleri

- Ürün kapsamı: çok cihazlı, her yerden erişilebilir kişisel ve kurumsal platform.
- PERSONAL ve BUSINESS çalışma alanları eklendi: ayrı relay, ayrı anahtar, ayrı kayıt, ayrı yetki (K9).
- İmzalı cihaz listesi ve telefon–bilgisayar güven bağları eklendi (K10, K13).
- Üç katmanlı kurtarma (K11), geri yükleme koruması ve iptal edilmiş anahtar yasağı (K13) eklendi.
- Alanlar arası aktarım Faz 2'ye ertelendi (K12).
- Güvenlik ifadeleri koşullu dile çevrildi; varsayımlar SECURITY.md §0'da tanımlandı (K14).
- Protokol başlığına `ws` ve `rh` alanları eklendi. Kriptografi çekirdeği değişmedi.
