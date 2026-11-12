# Kod İmzalama: Sertifika Türü ve İmzalama Mimarisi Önerisi

> **Tarih:** 2026-11-12
> **Durum:** Öneri. **Satın alma yapılmadı.** Proje sahibinin kararını bekliyor.
> **Kapsam:** Windows masaüstü uygulaması (Electron) ve Windows ajanı. Android imzalama ayrı bir konudur (Faz 1, Sprint 4).

## 1. Kısa Öneri

| Karar | Öneri |
|---|---|
| Sertifika türü | **OV (Organization Validation) kod imzalama sertifikası** |
| Anahtar saklama | **Bulut HSM / uzaktan imzalama hizmeti.** Anahtar hiçbir zaman dışa aktarılmaz. |
| İmzalama yeri | Yalnızca sürüm (release) hattı. Her imzalama, proje sahibinin onayına bağlı. |
| Güncelleme güvenliği | Authenticode imzasına **ek olarak** SAKLAZ'ın kendi çevrimdışı Ed25519 sürüm imzası |
| EV sertifika | Önerilmiyor (gerekçe §3) |
| Azure Artifact Signing | Şu an kullanılamıyor: Türkiye'deki kuruluşlar uygun değil (gerekçe §3) |

## 2. Araştırma Bulguları

### 2.1 EV sertifikası artık SmartScreen'de ayrıcalık sağlamıyor

- Microsoft'un kod imzalama seçenekleri sayfasına göre, EV sertifikaları eskiden ilk indirmede SmartScreen uyarısını atlatıyordu, ancak **bu davranış 2024'te kaldırıldı**. EV ile imzalanmış dosyalar artık OV ile aynı itibar oluşturma sürecinden geçiyor. Microsoft, yalnızca SmartScreen uyarısından kaçınmak için EV'ye ek ücret ödemenin artık gerekçelendirilemeyeceğini belirtiyor. Sayfa en son 2026-11-10'da güncellendi.
- **Kaynak çelişkisi:** Electron'un kendi dokümantasyonu hâlâ EV'nin gerekli olduğunu ve OV'nin fayda sağlamadığını söylüyor. Bu ifade, 2023'teki anahtar saklama kuralı değişikliğiyle EV gereksiniminin karıştırıldığı eski bir anlatım gibi görünüyor. Birincil kaynak Microsoft olduğu için Microsoft'un güncel sayfası esas alınmıştır.

### 2.2 Azure Artifact Signing Türkiye'de kullanılamıyor

- Microsoft'un önerdiği bulut imzalama hizmeti olan **Azure Artifact Signing** (eski adıyla Trusted Signing), Ocak 2026'da genel kullanıma açıldı.
- **Ücret:** Aylık yaklaşık 9,99 USD.
- **Sertifika ömrü:** 24 saatlik sertifikalar.
- **Uygunluk:** Hizmet yalnızca **ABD, Kanada, AB ve Birleşik Krallık'taki kuruluşlara** açık. Bu bölgelerin dışındaki geliştiricilere OV sertifika öneriliyor.
- **Not:** Şirketin AB'de tüzel kişiliği varsa veya Microsoft uygunluğu genişletirse bu seçenek yeniden değerlendirilmelidir; maliyet ve anahtar yönetimi açısından en iyi seçenektir.

### 2.3 Sertifika ömrü kısaldı

- CA/Browser Forum CSC-31 oylamasıyla, **24 Şubat 2026'dan itibaren** kod imzalama ve EV kod imzalama sertifikalarının azami ömrü **459 gün**.
- **Sonuç:** Yenileme yaklaşık her yıl yapılır. Yenileme süreci bir takvime bağlanmalıdır.

### 2.4 Özel anahtar dışa aktarılamaz

- 1 Haziran 2023'ten beri OV sertifikalarının özel anahtarları da PFX olarak dışa aktarılamaz.
- **Kabul edilen saklama yolları:**
  - FIPS onaylı donanım anahtarı (USB token)
  - Sağlayıcının uzaktan imzalama hizmeti
  - Anahtar üretim tasdiki (attestation) sunan bulut veya şirket içi HSM

### 2.5 Electron araç desteği

- electron-builder, Windows'ta CSP/anahtar kabı üzerinden HSM imzalamayı destekler. Ayrıca harici veya bulut imzalama hizmetleri için **özel `sign` kancası** (hook) sunar.
- `publisherName` alanı güncelleme doğrulamasında kullanılır.
- Electron'un kendi uygulamaları DigiCert KeyLocker kullanıyor.

## 3. Seçeneklerin Karşılaştırması

| Seçenek | Güvenlik | Maliyet | Türkiye'den uygunluk | CI uyumu | Değerlendirme |
|---|---|---|---|---|---|
| **OV + bulut uzaktan imzalama** | ✅ Anahtar HSM'de, dışa aktarılamaz; imzalama denetim kayıtlı | OV: yaklaşık 150–300 USD/yıl (Microsoft'un verdiği aralık). Bulut hizmeti ücreti sağlayıcıya göre değişir. | ✅ | ✅ GitHub Actions'tan çağrılabilir | **Önerilen** |
| OV + USB donanım anahtarı | ✅ Anahtar donanımda | Düşük | ✅ | ❌ Token fiziksel bir makineye bağlı; CI'da kullanımı zor, kaybolma ve bus factor riski var | Yedek seçenek |
| EV + bulut uzaktan imzalama | ✅ | 400+ USD/yıl | ✅ (doğrulama daha ağır) | ✅ | Yalnızca bir müşteri veya IT politikası EV şartı koşarsa |
| Azure Artifact Signing | ✅✅ Kısa ömürlü sertifika, yönetilen anahtar | Yaklaşık 9,99 USD/ay | ❌ TR kuruluşu uygun değil | ✅ | AB tüzel kişiliği varsa veya uygunluk genişlerse |
| Şirket içi CA (AD CS) ile imzalama | 🟨 Yalnız şirket bilgisayarlarında güvenilir | Düşük | ✅ | ✅ | Yalnızca kurum içi dağıtımda tamamlayıcı. Dışarıda geçersiz. |
| Microsoft Store (MSIX) | ✅ Store yeniden imzalar | Ücretsiz | ✅ | 🟨 | Kurumsal arka plan ajanı ve named pipe modeli için uygun değil |

## 4. Önerilen İmzalama Mimarisi

```
Geliştirici makinesi ──(imza YOK)──► GitHub (main)
                                          │
                                          ▼
                     Sürüm hattı (release workflow, korumalı ortam)
                     1. Temiz derleme, kilitli bağımlılıklar, testler
                     2. Proje sahibi onayı (GitHub "required reviewer")
                     3. Tüm PE dosyalarını OV ile imzala ──► Bulut HSM (anahtar dışarı çıkmaz)
                        + RFC 3161 zaman damgası
                     4. Sürüm manifesti üret (sürüm no, dosya özetleri)
                                          │
                                          ▼
                     Çevrimdışı imza ortamı (ayrı, internete kapalı)
                     5. Manifesti SAKLAZ yayın anahtarıyla (Ed25519) imzala
                                          │
                                          ▼
                     Güncelleme sunucusu (relay'den AYRI)
                                          │
                                          ▼
                     Windows ajanı güncelleme alırken:
                       a) Authenticode imzası + yayıncı adı doğru mu?
                       b) Manifest, SABİTLENMİŞ yayın anahtarıyla imzalı mı?
                       c) Dosya özetleri manifestle aynı mı?
                       d) Sürüm numarası mevcut sürümden büyük mü? (geri alma saldırısına karşı)
                       → dördü de geçerse kurulur
```

### 4.1 Neden iki ayrı imza?

| İmza | Kimin için | Neyi korur |
|---|---|---|
| **Authenticode (OV)** | Windows, SmartScreen, EDR/antivirüs, AppLocker/WDAC | Windows'un ve IT'nin yazılımı tanıması ve engellememesi |
| **SAKLAZ yayın imzası (Ed25519)** | SAKLAZ ajanının kendisi | Sertifika sağlayıcısı veya güncelleme sunucusu ele geçirilse bile, yalnızca bizim çevrimdışı anahtarımızla imzalanmış sürüm kurulur |

Bu yapı, SECURITY.md S14 ("imzalı güncelleme doğrulaması") kontrolünün temelidir.

### 4.2 İmzalanacak dosyalar

- **Masaüstü:**
  - Electron ana uygulaması (`SAKLAZ.exe`) ve tüm yardımcı `.exe` dosyaları
  - Ajan çalıştırılabilir dosyası
  - Native Node modülleri (`.node`, ör. `better-sqlite3`)
  - Yükleyici ve kaldırıcı
- **PowerShell betikleri:** Dağıttığımız betikler (ör. `windows-envanter.ps1`) de Authenticode ile imzalanır. Böylece `AllSigned` politikası olan bilgisayarlarda çalışırlar.
- **Zaman damgası:** Her imzaya RFC 3161 zaman damgası eklenir. Sertifikanın süresi dolsa bile imza geçerli kalır.

### 4.3 Anahtar ve yetki yönetimi

- İmzalama yalnızca sürüm hattından yapılır. Geliştirici makinelerinde imzalama yetkisi yoktur.
- **Bulut imzalama hizmeti hesabı:**
  - MFA zorunludur.
  - En az iki yetkili belirlenir (bus factor).
  - Her imzalama işlemi kayıt altına alınır.
- **SAKLAZ yayın anahtarı:**
  - Çevrimdışı ortamda tutulur (FAZ1-PLAN H7).
  - İki fiziksel yedeği ayrı güvenli konumlarda saklanır.
- **Yenileme takvimi:** Sertifika her 459 günde bir yenilenir. Bitişten 60 gün önce hatırlatma kurulur ve yenileme süreci bir runbook ile belgelenir.

### 4.4 Şirket IT'si ile birlikte

- **Yayıncı kuralı:** IT, EDR ve AppLocker/WDAC politikalarına SAKLAZ'ı **yayıncı (sertifika konusu) kuralıyla** ekleyebilir. Bu kural sertifika yenilemelerinde de geçerli kalır. Dosya özeti (hash) kuralı her sürümde bozulur; bu yüzden önerilmez. Bu, risk R4'ün (EDR engellemesi) ana önlemidir.
- **SmartScreen:** SmartScreen esas olarak internetten indirilen dosyalarda devreye girer. Kurulum Intune, SCCM veya GPO ile şirket içinden dağıtılırsa uyarı riski azalır. Yeni bir OV sertifikasının itibarı zamanla oluşur; ilk sürümlerde uyarı görülebilir.

## 5. Proje Sahibinin Kararı Gereken Konular

| # | Soru | Neden önemli |
|---|---|---|
| 1 | Şirketin AB'de tüzel kişiliği var mı? | Varsa Azure Artifact Signing en iyi seçenek olur. |
| 2 | Dağıtım yalnızca şirket bilgisayarlarına mı (Intune/GPO), yoksa dışarıya da mı olacak? | Kurum içi dağıtımda SmartScreen etkisi azalır, IT yayıncı kuralı yeterli olur. |
| 3 | Bir müşteri veya şirket politikası EV şartı koşuyor mu? | Koşuyorsa EV seçilir; koşmuyorsa ek maliyete gerek yok. |
| 4 | İmzalama yetkilileri kimler olacak (en az 2 kişi)? | Hesap kurtarma ve bus factor. |
| 5 | Sağlayıcı kısa listesi | Önerim: 2–3 CA'nın OV + bulut imzalama hizmetinden **yazılı teklif** almak. Değerlendirme ölçütleri: Türkiye'den kurumsal doğrulama süreci, GitHub Actions entegrasyonu, imza başına veya yıllık ücret, denetim kaydı. Fiyatları ben doğrulamadım; teklif aşamasında netleşmeli. |

**Zamanlama:** OV kurumsal doğrulaması günler ile haftalar sürebilir. İmzalı yükleyiciye en geç **Sprint 5'te** ihtiyaç var (şirket içi ilk kurulum). Kararın **Sprint 2 içinde** verilmesi önerilir.

## 6. Kaynaklar

- [Microsoft Learn — Code signing options for Windows apps](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) (en son 2026-11-10'da güncellendi)
- [ToDesktop — EV certs do not grant immediate reputation anymore](https://www.todesktop.com/blog/posts/windows-apps-psa-ev-certs-do-not-grant-immediate-reputation-anymore)
- [DigiCert — Code signing certificates 459-day validity](https://knowledge.digicert.com/alerts/code-signing-certificates-459-day-validity)
- [DevClass — Azure Artifact Signing (Ocak 2026)](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554)
- [SSL.com — Code signing key storage requirements (1 Haziran 2023)](https://ssl.com/article/code-signing-key-storage-requirements-will-change-on-june-1-2023/)
- [electron-builder — WindowsHsmSigningConfig](https://www.electron.build/docs/api/app-builder-lib.Interface.WindowsHsmSigningConfig)
- [Electron — Code Signing](https://electronjs.org/docs/latest/tutorial/code-signing)
