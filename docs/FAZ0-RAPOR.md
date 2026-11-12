# Faz 0 Sonuç Raporu

> **Tarih:** 2026-11-12
> **Durum:** Proje sahibinin incelemesine ve kararlarına sunulmuştur.
> **Not:** MVP geliştirmesi başlamamıştır ve ayrı onay beklemektedir.

## 1. Yapılanlar

| Çıktı | Açıklama |
|---|---|
| `ARCHITECTURE.md` v0.2 | Proje sahibinin 2026-11-12 tarihli kuralları (K1–K8) mimariye işlendi. Merkez sunucu artık yalnızca bir **kör aktarıcı** (relay). Telefon ile Windows arası **uçtan uca şifreli**. Ajan yalnızca telefonun **imzaladığı** komutları çalıştırıyor. Self-hosted barındırma seçenekleri eklendi. |
| `SECURITY.md` v0.2 | Güven modeli yeniden kuruldu. Eşleştirme protokolü relay'e güvenmiyor (QR + SAS). Noise_KK oturumu, imzalı onay, replay koruması ve "relay ele geçirilirse" analizi eklendi. 16 maddelik kontrol tablosu var. |
| `docs/REQUIREMENTS.md` | Fonksiyonel ve fonksiyonel olmayan gereksinimler, her biri için doğrulama yöntemiyle birlikte. |
| `docs/RISKS.md` | 16 maddelik risk kaydı. |
| `docs/discovery/ASEDEN-KESIF.md` | ASEDEN için 5 adımlı, salt okunur keşif planı. 5 entegrasyon seçeneği karşılaştırıldı. Kabul edilmeyecek yöntemler tanımlandı. Bulgu tablosu açıldı. |
| `tools/discovery/aseden-pg-katalog.sql` | Yalnızca sistem kataloğunu okuyan keşif betiği. Yerel bir test PostgreSQL 16 sunucusunda hatasız çalıştı. Yazma girişiminin reddedildiği doğrulandı. |
| `tools/discovery/windows-envanter.ps1` | Windows ortam envanteri betiği: OS, Office/Outlook türü, EDR, proxy, yetkiler. **Linux geliştirme ortamında PowerShell bulunmadığı için henüz çalıştırılmadı.** İlk Windows çalıştırmasında doğrulanacak. |
| `docs/adr/README.md` | 6 mimari karar listelendi. Outlook'un MVP dışında tutulması kabul edildi. |

## 2. Yapılamayanlar ve Nedenleri

| Talep | Durum | Neden |
|---|---|---|
| ASEDEN üretim bağlantılarının incelenmesi | ⏸ Yapılamadı | Bu geliştirme ortamının ASEDEN'in kaynak koduna, sunucusuna, veritabanına veya Firebase projesine erişimi yok. Erişim, sahibinin açık onayıyla ve salt okunur olarak verilmeli. |
| Gerçek veritabanı motorunun tespiti | ⏸ Yapılamadı | Aynı neden. Tespit için kanıt toplama yöntemi hazır (keşif belgesi, Adım A–D). |
| Resmî API araştırması | ⏸ Yapılamadı | Kaynak kod veya ASEDEN dokümantasyonu gerekli. Kamuya açık bir kaynakta bulunacak bir bilgi değil. |
| GitHub'a gönderme | ⏸ Yapılamadı | `SAKLAZ5341/SAKLAZ-A-BUS-NESS` reposuna bu oturumdan erişilemiyor. Repo listesi servisi de geçici olarak yanıt vermedi. |

**Önemli:** "PostgreSQL'e geçildi" ve "Firestore kullanılmıyor" bilgileri tüm belgelerde **doğrulanmamış beyan** olarak işaretlendi. Doğrulanana kadar bunlara dayanan hiçbir kod yazılmayacak.

## 3. Proje Sahibinden Beklenen Kararlar ve Erişimler

| # | Konu | Seçenekler | Önerim |
|---|---|---|---|
| 1 | **Relay barındırma** | A) Şirket içi VM + yalnızca 443 dışa açık · B) Şirket içi VM + yalnızca VPN · C) Şirket adına yurt içi VPS | **A**. E2EE sayesinde relay yalnızca meta veri görüyor. Telefonun her yerden bağlanabilmesi kullanılabilirlik için önemli. IT politikası izin vermezse B. |
| 2 | **Push bildirim** | FCM, yalnızca içeriksiz sinyal · Self-hosted (ntfy/UnifiedPush) | **FCM, içeriksiz.** Android'de güvenilir teslimatın pratik yolu bu. Hiçbir şirket verisi taşımaz. |
| 3 | **ASEDEN kaynak koduna salt okunur erişim** | GitHub repo okuma izni veya kodun arşiv olarak paylaşılması | Keşif Adım A için en hızlı ve en güvenli yol. |
| 4 | **ASEDEN canlı sistem keşfi (Adım B–D)** | ASEDEN yöneticisi uygular, çıktıları maskeleyerek paylaşır | Katalog betiği hazır. Keşif rolünün oluşturulması ASEDEN sahibinin kararı. |
| 5 | **Windows envanteri** | Hedef bilgisayarda `windows-envanter.ps1` çalıştırılır | En az bir tipik kullanıcı bilgisayarında. |
| 6 | **GitHub erişimi** | claude.ai → Ayarlar → Connectors → GitHub bağlantısını yenilemek ve bu repoya izin vermek | Erişim gelince tüm belgeler tek bir commit olarak gönderilir. |
| 7 | **MVP'nin ASEDEN keşfiyle paralel yürütülmesi** | Evet / Hayır | **Evet.** ERP, MVP kapsamında değil. MVP'nin ASEDEN keşfini beklemesi gerekmiyor. |

## 4. Önemli Mimari Değişiklik (onayınızı gerektiriyor)

Kurallarınız (özellikle K5, "sunucu ele geçirilse bile kritik işlem yaptıramaz") v0.1'den daha güçlü bir model gerektirdi. Yalnızca onayları imzalamak yetmiyordu: ele geçirilmiş bir sunucu, onay gerektirmeyen okuma komutlarıyla veri sızdırabilirdi.

Bu nedenle v0.2'de şu değişiklikler yapıldı:

- **Her komut** telefonda imzalanıyor.
- **Tüm içerik** uçtan uca şifreleniyor.
- Sunucu yalnızca şifreli zarfları iletiyor.

Bu değişikliğin bedelleri:

- Faz 1 süresi tahmini 2 hafta uzadı.
- Mobil ve masaüstü arasında kripto uyumluluğu için ek test yükü oluştu.
- Telefon kaybında kurtarma yalnızca Windows tarafından yapılabiliyor; sunucudan yapılamıyor.

Uzun vadeli ve profesyonel bir ürün için bu bedellerin doğru olduğunu düşünüyorum.

## 5. Sonraki Adım

Bu rapordaki 1, 2 ve 7 numaralı kararlar verildiğinde ve belgeler onaylandığında Faz 1 (MVP) planını ayrıntılandırıp **ayrıca onayınıza sunacağım**. ASEDEN keşfi, erişim sağlandıkça paralel olarak tamamlanacak.
