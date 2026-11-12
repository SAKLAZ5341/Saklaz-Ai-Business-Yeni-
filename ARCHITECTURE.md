# SAKLAZ AI — Teknik Mimari

> Durum: **Taslak v0.1 — onay bekliyor.** Bu doküman tasarımdır; burada anlatılan hiçbir bileşen henüz kodlanmamış veya test edilmemiştir.

## 1. Amaç ve Kapsam

SAKLAZ AI; Windows bilgisayarda çalışan bir ajan, Android (Flutter) mobil uygulama ve internet üzerindeki merkezi bir sunucudan oluşan, modüler ve çoklu ajanlı bir kişisel/kurumsal asistan ekosistemidir. ASEDEN ERP ile **bağımsız ve varsayılan olarak salt okunur** bir connector üzerinden entegre olur. ASEDEN'in kaynak koduna, veritabanı şemasına veya çalışan sistemine hiçbir değişiklik yapılmaz.

### Temel tasarım ilkeleri

1. **Veri yerinde kalır.** Dosyalar, ERP verisi ve e-postalar Windows ajanının bulunduğu makinede işlenir. Merkezi sunucuya yalnızca görev tanımı, durum ve kullanıcının açıkça paylaşmayı seçtiği çıktılar gider.
2. **Varsayılan reddet (deny-by-default).** Ajan yalnızca izin verilen klasörlere, uygulamalara ve araçlara erişir.
3. **Kritik işlem = açık onay.** Silme, e-posta gönderme, ERP'ye yazma, sipariş değiştirme gibi işlemler kullanıcının cihazında imzalı onay olmadan çalışmaz.
4. **Sağlayıcı bağımsızlığı.** AI sağlayıcısı bir arayüz arkasındadır; hiçbiri zorunlu değildir. AI yoksa kural tabanlı otomasyonlar çalışmaya devam eder.
5. **Dürüst durum.** Mock veri her zaman `source: "mock"` olarak işaretlenir; arayüzde "DEMO VERİ" etiketiyle gösterilir.

## 2. Üst Düzey Mimari

```
┌──────────────────────┐        HTTPS / WSS (TLS 1.3)        ┌───────────────────────────┐
│  Android Uygulaması  │ ◄─────────────────────────────────► │      SAKLAZ Merkez        │
│  (Flutter)           │                                     │  (Node.js + TypeScript)   │
│  - Komut / ses       │        FCM (yalnızca "uyandırma")   │  - Auth + MFA             │
│  - Onay (biyometrik) │ ◄────────────────────────────────── │  - Cihaz yönetimi         │
│  - Görev geçmişi     │                                     │  - Görev kuyruğu          │
└──────────────────────┘                                     │  - WebSocket hub          │
                                                             │  - Audit log              │
                                                             └─────────────▲─────────────┘
                                                                           │
                                                 Giden (outbound) WSS — │ — Windows'ta açık port YOK
                                                                           │
┌──────────────────────────────────────────────────────────────────────────┴──────────────┐
│                               Windows Bilgisayar                                         │
│  ┌────────────────────┐   IPC (named pipe, yalnız yerel kullanıcı)   ┌─────────────────┐ │
│  │ Masaüstü UI        │ ◄──────────────────────────────────────────► │ SAKLAZ Agent    │ │
│  │ (Electron + React) │                                              │ Servisi (Node)  │ │
│  └────────────────────┘                                              │ - Orkestratör   │ │
│                                                                      │ - Uzman ajanlar │ │
│                                                                      │ - Araç katmanı  │ │
│                                                                      │ - Politika motoru│ │
│                                                                      │ - Yerel SQLite  │ │
│                                                                      └───────┬─────────┘ │
│                                                                              │           │
│              ┌──────────────┬──────────────┬───────────────┬─────────────────┤           │
│              ▼              ▼              ▼               ▼                 ▼           │
│        İzinli klasörler  Office/PDF   Outlook (Graph/   Tarayıcı        ASEDEN ERP       │
│        (allowlist)       okuyucular   COM)              (Playwright)    Connector (R/O)  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                 │
                                                                     Salt okunur DB kullanıcısı
                                                                     veya mevcut API (incelenecek)
```

### Görev akışı (uzaktan komut)

1. Kullanıcı telefondan komut yazar/söyler → Merkez `tasks` tablosuna `queued` olarak kaydeder.
2. Merkez, hedef Windows cihazının açık WSS bağlantısı üzerinden görevi iletir.
3. Agent görevi **planlar** (AI varsa LLM ile, yoksa kural/şablon ile) ve her adımı politika motorundan geçirir.
4. Risk seviyesi `critical` olan adım varsa görev `awaiting_approval` olur; telefona bildirim gider, kullanıcı biyometrik onay verir, onay cihaz anahtarıyla imzalanır.
5. Agent imzayı doğrular, adımı çalıştırır, sonuçları yerelde saklar; özet ve (izin verildiyse) çıktı dosyası Merkez'e yüklenir.
6. Her adım hem yerel hem merkezi audit log'a yazılır.

## 3. Bileşenler

### 3.1 Merkez Sunucu (`apps/server`)

| Modül | Sorumluluk |
|---|---|
| `auth` | Kayıt/giriş, Argon2id parola, TOTP MFA, kısa ömürlü access token + dönen refresh token |
| `devices` | Cihaz eşleştirme (QR + tek kullanımlık kod), cihaz açık anahtarları, iptal |
| `tasks` | Görev oluşturma, kuyruk, durum makinesi, yeniden deneme, zaman aşımı |
| `approvals` | Onay istekleri, imza doğrulama, süre sonu |
| `realtime` | WebSocket hub (cihaz ve mobil oturumları), heartbeat, bağlantı durumu |
| `notifications` | FCM push (yalnızca "yeni olay var" — içerik değil) |
| `artifacts` | Kullanıcının paylaşmayı seçtiği rapor/dosyaların şifreli saklanması |
| `audit` | Değiştirilemez (append-only, hash zincirli) denetim kaydı |
| `rbac` | Rol ve izin kontrolü |

### 3.2 Windows Agent Servisi (`apps/agent`)

- Kullanıcı oturumu düzeyinde çalışan Node.js süreci (SYSTEM yetkisiyle **değil**). Oturum açılışında başlatılır; Windows Hizmeti olarak çalıştırma Faz 3'te değerlendirilecek.
- **Orkestratör:** Görevi alt adımlara böler, uygun uzman ajana yönlendirir.
- **Araç katmanı (tools):** Her araç; ad, giriş şeması (zod), risk seviyesi (`read` / `write` / `critical`) ve gerekli izinleri bildirir. Ajanlar yalnızca araçlar üzerinden dünyaya dokunabilir.
- **Politika motoru:** Klasör allowlist'i, uygulama allowlist'i, risk → onay eşlemesi, rate limit.
- **Yerel depo:** SQLite (görev önbelleği, yerel audit, ayarlar). Gizli bilgiler Windows Credential Manager / DPAPI'de.

### 3.3 Masaüstü UI (`apps/desktop`)

Electron + React. Agent servisiyle yalnızca yerel named pipe üzerinden konuşur; renderer sürecinde Node erişimi kapalı (`contextIsolation`, `sandbox`). Ekranlar: Sohbet, Görevler, Ajanlar, Onaylar, Bildirim Merkezi, İşlem Geçmişi, Sistem Durumu, Ayarlar/İzinler. Koyu tema, lacivert/mavi palet, sol navigasyon.

### 3.4 Android Uygulaması (`apps/mobile`)

Flutter. Riverpod (durum), Dio (HTTP), `web_socket_channel`, `firebase_messaging`, `local_auth` (biyometrik), `flutter_secure_storage` (Android Keystore), `speech_to_text` (cihaz üzeri tanıma tercih edilir).

### 3.5 ASEDEN ERP Connector (`packages/erp-aseden`)

- Agent içinde, yerel ağda çalışır; ERP verisi buluta çıkmaz.
- `ErpConnector` arayüzü: `listPurchaseRequests`, `listQuotes`, `listOrders`, `listSuppliers`, `getStock`, `listAs9100Records`, `runReport`.
- **Faz 0'da yapılacak keşif tamamlanmadan hiçbir gerçek bağlantı kodu yazılmaz.** Keşifte: veritabanı motoru, sürüm, ilgili tablolar/view'lar, mevcut API varlığı, yetki modeli belgelenecek.
- Bağlantı tercihi: (1) ASEDEN'in resmi API'si varsa o; (2) yoksa ERP yöneticisinin oluşturacağı **yalnız SELECT yetkili** DB kullanıcısı ve tercihen bizim için açılmış view'lar.
- Yazma işlemleri ileride `ErpWriteConnector` olarak ayrı paket, ayrı kimlik bilgisi ve zorunlu onay ile eklenir.
- Testlerde `MockErpConnector` kullanılır; döndürdüğü her kayıt `source: "mock"` taşır.

### 3.6 Uzman Ajanlar (`packages/agents/*`)

| Ajan | Kullandığı araçlar | MVP? |
|---|---|---|
| Excel ve Raporlama | dosya okuma, xlsx okuma/yazma, docx/pdf oluşturma | ✅ |
| Kişisel Asistan | dosya arama, not, hatırlatma | ✅ (temel) |
| Satınalma | ERP connector (R/O), raporlama | Faz 2 |
| AS9100 Kalite | ERP connector, belge okuma, kontrol listeleri | Faz 2 |
| Yönetim Raporlama | ERP + Excel ajanlarının çıktıları | Faz 2 |
| E-posta | Outlook (okuma; gönderme = critical) | Faz 3 |
| Bilgisayar Kontrol | uygulama açma, tarayıcı (Playwright), ekran yardımı | Faz 3 |

Her ajan bir `AgentDefinition` ile tanımlanır: kimlik, açıklama, sistem talimatı, kullanabileceği araç listesi, kural tabanlı fallback planları.

### 3.7 AI Katmanı (`packages/ai`)

```ts
interface AIProvider {
  id: string;
  capabilities: { tools: boolean; vision: boolean; local: boolean };
  chat(req: ChatRequest, opts: { signal: AbortSignal }): Promise<ChatResponse>;
}
```

- Adaptörler: Anthropic, OpenAI uyumlu API'ler, Ollama (yerel). Hepsi isteğe bağlı.
- **Veri paylaşım politikası:** Her istek öncesi `DataGuard` çalışır; dış sağlayıcıya gidecek içerik, kullanıcının o sağlayıcı ve o veri sınıfı için verdiği izinle karşılaştırılır. ERP ve AS9100 verisi varsayılan olarak yalnızca yerel modele gönderilebilir.
- **Fallback:** Sağlayıcı yoksa/erişilemezse `RuleEngine` devreye girer (anahtar kelime + şablon tabanlı komutlar: "X klasöründeki Excel'leri özetle", "bu hafta açık siparişleri raporla" vb.).
- Dosya/e-posta/web içeriği LLM'e her zaman **veri** olarak, ayrı bir blokta verilir; içindeki talimatlar uygulanmaz (prompt injection savunması, bkz. SECURITY.md).

## 4. Teknoloji Seçimleri ve Gerekçeleri

| Alan | Seçim | Gerekçe | Değerlendirilen alternatif |
|---|---|---|---|
| Dil | TypeScript (strict) | Talep edilen; sunucu, ajan ve masaüstü arasında ortak tip/şema | — |
| Monorepo | pnpm workspaces + Turborepo | Paylaşılan paketler, hızlı önbellekli build | Nx (daha ağır) |
| Sunucu | Node.js 22 LTS + Fastify | Yüksek performans, şema tabanlı doğrulama, olgun eklenti ekosistemi | Express (daha yavaş, daha az yapı), NestJS (daha fazla soyutlama) |
| Veritabanı | PostgreSQL 16 | İlişkisel veri, JSONB, row-level güvenlik, olgun yedekleme | MySQL |
| ORM | Drizzle ORM | SQL'e yakın, TypeScript tip güvenliği, şeffaf migration | Prisma (ağır çalışma zamanı) |
| Kuyruk | pg-boss (PostgreSQL üstünde) | MVP'de ek altyapı (Redis) gerektirmez | BullMQ + Redis (ölçek gerekirse Faz 4) |
| Gerçek zamanlı | `ws` + kendi protokolümüz | Hafif, tam kontrol; mesajlar zod ile doğrulanır | Socket.IO |
| Doğrulama | zod | Tüm sınır noktalarında aynı şema | — |
| Masaüstü | Electron + React + Vite | TypeScript gereksinimi; Windows/Office entegrasyon kütüphaneleri | Tauri (Rust gerektirir) |
| UI kit | Tailwind + Radix UI | Erişilebilir, özelleştirilebilir koyu tema | MUI |
| Excel | ExcelJS | Okuma/yazma, stiller, formüller | SheetJS |
| Word | mammoth (okuma), docx (yazma) | Saf JS, Office kurulumu gerektirmez | — |
| PDF | pdfjs-dist (okuma), pdfkit (yazma) | Saf JS | — |
| Outlook | Microsoft Graph (M365) / PowerShell-COM köprüsü (klasik Outlook) | Ortama göre; Faz 0'da hangisinin kullanıldığı tespit edilecek | — |
| Tarayıcı | Playwright | Güvenilir, ayrı profil ile izole | Puppeteer |
| Yerel DB | better-sqlite3 | Gömülü, hızlı, kurulum gerektirmez | — |
| Mobil | Flutter 3 + Riverpod | Talep edilen; tek kod tabanı | — |
| Push | Firebase Cloud Messaging | Android standardı | — |
| Test | Vitest, Playwright (E2E), flutter_test | Hızlı, TS uyumlu | Jest |
| Gözlemlenebilirlik | pino (yapısal log), OpenTelemetry (Faz 3) | — | — |
| Dağıtım | Docker Compose (sunucu), electron-builder + kod imzalama (masaüstü) | Basit, tekrarlanabilir | Kubernetes (gereksiz karmaşıklık) |

> Not: Mobil uygulama Dart ile yazılacaktır (Flutter gereksinimi). Mobil ile sunucu arasındaki sözleşme OpenAPI'den otomatik üretilen Dart istemcisi ile tip güvenli tutulur.

## 5. Proje Klasör Yapısı

```
saklaz-ai/
├── ARCHITECTURE.md
├── ROADMAP.md
├── SECURITY.md
├── README.md
├── package.json                 # pnpm workspace kökü
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .github/workflows/           # CI: lint, typecheck, test, güvenlik taraması
├── docs/
│   ├── adr/                     # Mimari karar kayıtları
│   ├── discovery/               # Faz 0 ortam ve ASEDEN keşif raporları
│   └── api/                     # OpenAPI tanımı
├── apps/
│   ├── server/                  # Merkez (Fastify)
│   │   ├── src/{auth,devices,tasks,approvals,realtime,notifications,artifacts,audit,rbac}/
│   │   ├── src/db/{schema,migrations}/
│   │   └── test/
│   ├── agent/                   # Windows ajan servisi
│   │   ├── src/{orchestrator,policy,tools,transport,ipc,store,secrets}/
│   │   └── test/
│   ├── desktop/                 # Electron + React UI
│   │   └── src/{main,preload,renderer}/
│   └── mobile/                  # Flutter uygulaması
│       └── lib/{features,core,data}/
├── packages/
│   ├── protocol/                # Mesaj tipleri ve zod şemaları (sunucu ↔ ajan ↔ UI)
│   ├── ai/                      # AIProvider arayüzü, adaptörler, DataGuard, RuleEngine
│   ├── agents/                  # Uzman ajan tanımları
│   │   ├── reporting/
│   │   ├── personal/
│   │   ├── purchasing/
│   │   ├── quality-as9100/
│   │   ├── email/
│   │   ├── computer-control/
│   │   └── management-reporting/
│   ├── tools/                   # Araçlar (fs, xlsx, docx, pdf, outlook, browser, apps)
│   ├── erp-core/                # ErpConnector arayüzü + MockErpConnector
│   ├── erp-aseden/              # ASEDEN connector (keşiften sonra)
│   ├── crypto/                  # İmza, eşleştirme, anahtar yönetimi yardımcıları
│   ├── ui/                      # Paylaşılan React bileşenleri ve tema
│   └── config/                  # eslint, tsconfig, vitest ortak ayarları
└── infra/
    ├── docker/                  # docker-compose (server, postgres)
    └── scripts/
```

## 6. Veritabanı Tasarımı

### 6.1 Merkez (PostgreSQL)

```
users
  id uuid PK, email citext UNIQUE, password_hash text, display_name text,
  mfa_secret_enc bytea NULL, mfa_enabled bool, status enum(active,locked,disabled),
  created_at, updated_at, last_login_at

roles             id, name UNIQUE (owner, admin, operator, viewer), description
permissions       id, key UNIQUE (ör. "task.create", "approval.grant", "erp.read")
role_permissions  role_id FK, permission_id FK, PK(role_id, permission_id)
user_roles        user_id FK, role_id FK, organization_id FK, PK(...)

organizations     id, name, created_at                 # kurumsal kullanım için

refresh_tokens
  id, user_id FK, token_hash, family_id, expires_at, revoked_at, created_ip, user_agent

devices
  id uuid PK, owner_user_id FK, organization_id FK, kind enum(windows_agent, android),
  name, public_key bytea (Ed25519), platform_info jsonb, status enum(active,revoked),
  last_seen_at, created_at, revoked_at

pairing_codes
  id, user_id FK, code_hash, kind, expires_at (≤5 dk), used_at, attempts

tasks
  id uuid PK, organization_id FK, created_by_user_id FK, source_device_id FK,
  target_device_id FK, agent_key text, title, input jsonb,
  status enum(queued, dispatched, running, awaiting_approval, succeeded, failed, cancelled, expired),
  priority smallint, result_summary text, error jsonb,
  created_at, started_at, finished_at

task_events
  id bigserial PK, task_id FK, seq int, type text, payload jsonb, created_at
  UNIQUE(task_id, seq)

approvals
  id uuid PK, task_id FK, step_id text, action_key text, risk enum(write, critical),
  description text, params_digest bytea (sha256), requested_at, expires_at,
  decided_by_user_id FK, decided_device_id FK, decision enum(approved, rejected, expired),
  signature bytea, decided_at

artifacts
  id uuid PK, task_id FK, owner_user_id FK, filename, mime, size_bytes,
  sha256, storage_key, encryption_key_id, is_mock bool, created_at, expires_at

notifications
  id, user_id FK, type, title, body, ref_type, ref_id, read_at, created_at

ai_provider_configs
  id, organization_id FK, provider_key, display_name, enabled bool,
  allowed_data_classes text[], settings jsonb, created_at
  # API anahtarları burada TUTULMAZ; ajan tarafında yerel kasada saklanır

audit_logs (append-only)
  id bigserial PK, occurred_at timestamptz, actor_type enum(user, device, system),
  actor_id, organization_id, action text, target_type, target_id,
  ip inet, details jsonb, prev_hash bytea, hash bytea
```

İndeksler: `tasks(target_device_id, status)`, `tasks(created_by_user_id, created_at desc)`, `task_events(task_id, seq)`, `audit_logs(organization_id, occurred_at)`, `notifications(user_id, read_at)`.

`audit_logs` için uygulama DB kullanıcısının yalnızca `INSERT` ve `SELECT` yetkisi olur; `UPDATE/DELETE` yetkisi verilmez.

### 6.2 Windows Agent (SQLite, yerel)

```
settings           key PK, value
folder_grants      id, path, access enum(read, read_write), recursive bool, granted_at, granted_by
app_grants         id, exe_path, sha256, display_name, granted_at
local_tasks        id (merkezdeki task id), status, plan jsonb, created_at, updated_at
local_steps        id, task_id, tool_key, risk, input jsonb, output_ref, status, started_at, finished_at
local_audit        id, occurred_at, action, details jsonb, prev_hash, hash
outbox             id, kind, payload jsonb, created_at, sent_at   # çevrimdışı senkron için
erp_cache          entity, key, data jsonb, fetched_at, ttl       # yalnız R/O önbellek, Faz 2
```

## 7. Gerçek Zamanlı Protokol (özet)

Tüm mesajlar `packages/protocol` içinde zod şemasıyla tanımlanır:

```ts
type Envelope =
  | { t: "hello"; deviceId; nonce; sig }           // ajan → merkez: kimlik kanıtı
  | { t: "task.dispatch"; task }                    // merkez → ajan
  | { t: "task.event"; taskId; seq; event }         // ajan → merkez
  | { t: "approval.request"; approval }             // ajan → merkez → mobil
  | { t: "approval.decision"; approvalId; decision; sig } // mobil → merkez → ajan
  | { t: "ping" } | { t: "pong" };
```

Doğrulanamayan veya şemaya uymayan mesaj bağlantıyı kapatır ve audit'e yazılır.

## 8. Hata Yönetimi

- Tüm modüller `Result`/tipli hata sınıfları kullanır (`ValidationError`, `PermissionDenied`, `ApprovalRequired`, `ToolFailure`, `ProviderUnavailable`).
- Görev adımları idempotent anahtarla çalışır; yeniden denemede çift işlem olmaz.
- Ajan bağlantısı koptuğunda olaylar `outbox`'ta biriktirilir, yeniden bağlanınca sırayla gönderilir.
- Kullanıcıya gösterilen hata mesajları Türkçe ve eyleme dönüktür; teknik detay yalnız loglarda.

## 9. Açık Sorular (Faz 0'da yanıtlanacak)

1. ASEDEN ERP'nin veritabanı motoru ve sürümü nedir? Resmî bir API'si var mı?
2. ERP yöneticisi salt okunur bir kullanıcı/view oluşturabilir mi?
3. Outlook klasik masaüstü mü, Microsoft 365 / Exchange Online mı?
4. Merkez sunucu nerede barındırılacak (şirket içi, Türkiye'de bulut, yurt dışı bulut)? KVKK ve savunma sanayii müşteri gereksinimleri (ör. ROKETSAN) veri yerleşimini etkileyebilir.
5. Kaç kullanıcı ve kaç Windows cihazı hedefleniyor?
6. Dış AI sağlayıcılarına hangi veri sınıflarının gönderilmesine izin verilecek?
7. Windows makinelerde yönetici yetkisi ve kod imzalama sertifikası mevcut mu?
