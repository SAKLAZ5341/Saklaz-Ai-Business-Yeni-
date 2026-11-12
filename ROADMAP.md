# SAKLAZ AI — Yol Haritası

> **Sürüm:** v0.2 (Faz 0), 2026-11-12
> **Varsayım:** Süreler, tek tam zamanlı geliştirici varsayımıyla kaba tahmindir.
>
> **Durum işaretleri:**
> - ⬜ Planlandı
> - 🟨 Devam ediyor
> - ⏸ Proje sahibinin girdisini bekliyor
> - ✅ Tamamlandı (yalnızca testi geçen maddeler)
>
> Her faz, proje sahibinin **ayrı onayıyla** başlar.

## Faz 0 — Keşif ve Temel Tasarım (onaylandı: 2026-11-12)

### Belgeler

| Madde | Durum |
|---|---|
| Mimari belgesi v0.2: kör relay, E2EE, self-hosted (ARCHITECTURE.md) | 🟨 Taslak hazır, onay bekliyor |
| Güvenlik modeli v0.2: tehdit modeli, eşleştirme, onay kriptografisi (SECURITY.md) | 🟨 Taslak hazır, onay bekliyor |
| Teknik gereksinimler (docs/REQUIREMENTS.md) | 🟨 Taslak hazır |
| Risk kaydı (docs/RISKS.md) | 🟨 Taslak hazır |
| ADR listesi (docs/adr) | 🟨 Taslak hazır |
| Faz 0 sonuç raporu (docs/FAZ0-RAPOR.md) | 🟨 Taslak hazır |

### Keşif araçları

| Madde | Durum |
|---|---|
| ASEDEN keşif planı ve entegrasyon seçenekleri (docs/discovery/ASEDEN-KESIF.md) | ✅ Belge hazır |
| ASEDEN katalog keşif betiği (tools/discovery/aseden-pg-katalog.sql) | ✅ Yerel test PostgreSQL 16'da çalıştı; salt okunur koruma doğrulandı |
| Windows envanter betiği (tools/discovery/windows-envanter.ps1) | 🟨 Yazıldı. **Henüz Windows'ta test edilmedi.** İlk çalıştırmada doğrulanacak. |

### Keşfin yürütülmesi

| Madde | Durum |
|---|---|
| ASEDEN Adım A: kaynak kod incelemesi | ⏸ Kaynak koda salt okunur erişim gerekli |
| ASEDEN Adım B–D: çalışan sistem, Firestore kullanımı, katalog | ⏸ ASEDEN yöneticisi tarafından yürütülecek |
| ASEDEN bulgu tablosunun doldurulması ve entegrasyon yönteminin seçimi | ⏸ |
| Windows envanteri: en az bir hedef bilgisayarda | ⏸ |

### Kararlar

| Madde | Durum |
|---|---|
| Barındırma kararı | ✅ Karar verildi: şirket içi VM, yalnızca 443 (2026-11-12) |
| Push bildirim kararı | ✅ Karar verildi: FCM, yalnızca içeriksiz uyandırma (2026-11-12) |

### Altyapı

| Madde | Durum |
|---|---|
| GitHub repo erişimi | ⏸ Erişim izni gerekli |

### Çıkış kriteri

- Belgeler onaylandı.
- ASEDEN bulgu tablosundaki B1–B4 dolduruldu. B5–B8, Faz 2 öncesine kadar tamamlanabilir.
- Barındırma ve push kararları verildi.
- Windows envanteri alındı.

> **Not:** ASEDEN keşfi MVP'yi **engellemez**, çünkü ERP MVP kapsamında değildir. Bu nedenle, Faz 0 belgeleri ve barındırma kararı onaylanırsa MVP, ASEDEN keşfiyle paralel yürüyebilir. Bu, proje sahibinin onayına bağlıdır.

## Faz 1 — MVP (≈10 hafta, 5 sprint)

> Ayrıntılı plan: [docs/FAZ1-PLAN.md](docs/FAZ1-PLAN.md). Plan proje sahibi tarafından onaylandı (2026-11-12). MVP, ASEDEN keşfiyle paralel yürür ama ondan tamamen bağımsızdır ve yalnızca sentetik test verisi kullanır.

### Sprint durumu

| Sprint | Durum | Rapor |
|---|---|---|
| S1 — Temel ve kripto | 🟨 Tamamlandı. Dart testi ve GitHub CI çalıştırması bekliyor. | [SPRINT-1-RAPOR.md](docs/sprints/SPRINT-1-RAPOR.md) |
| S2 — Relay ve eşleştirme | ⏸ Proje sahibinin onayını bekliyor | — |
| S3 — Ajan çekirdeği ve araçlar | ⬜ | — |
| S4 — Android ve masaüstü | ⬜ | — |
| S5 — Sağlamlaştırma | ⬜ | — |

**Amaç:** Telefondan uçtan uca şifreli ve imzalı komutla Windows'ta dosya analizi ve rapor üretmek.

E2EE ve relay modeli nedeniyle v0.1 tahmini 2 hafta artırıldı.

### Kapsam

**Temel ve kripto**

- ⬜ Monorepo, CI (lint, typecheck, test, gitleaks, CodeQL)
- ⬜ `packages/protocol`: Zarf şemaları, kanonik JSON, test vektörleri
- ⬜ `packages/crypto`: Eşleştirme (QR + SAS), Noise_KK oturumu, imza ve replay koruması

**Relay**

- ⬜ Hesap ve MFA
- ⬜ Cihaz kaydı
- ⬜ Şifreli yönlendirme ve süreli kuyruk
- ⬜ Çevrimiçi durumu (presence)
- ⬜ Push sinyali
- ⬜ Meta veri denetim kaydı
- ⬜ Docker Compose ile kurulum

**Ajan**

- ⬜ Transport ve verifier
- ⬜ Politika motoru ve klasör allowlist
- ⬜ Araçlar: dosya, Excel, PDF, Word okuma ve rapor üretimi
- ⬜ Onay akışı
- ⬜ Yerel denetim kaydı

**AI**

- ⬜ `AIProvider` arayüzü
- ⬜ RuleEngine
- ⬜ Ollama adaptörü (opsiyonel)
- ⬜ DataGuard

**Ajanlar**

- ⬜ Excel ve Raporlama
- ⬜ Kişisel Asistan (temel)

**Masaüstü UI**

- ⬜ Sohbet
- ⬜ Görevler
- ⬜ Onaylar
- ⬜ İşlem Geçmişi
- ⬜ Sistem Durumu
- ⬜ İzinler
- ⬜ Eşleştirilmiş Cihazlar

**Android**

- ⬜ Giriş ve MFA
- ⬜ Eşleştirme
- ⬜ Yazılı komut
- ⬜ Görev geçmişi
- ⬜ Cihaz durumu
- ⬜ Push bildirim
- ⬜ Biyometrik imzalı onay
- ⬜ Rapor görüntüleme

### MVP dışı (bilinçli)

| Madde | Faz |
|---|---|
| ASEDEN connector | 2 |
| Sesli komut | 2 |
| **Outlook** (sürüm ve yöntem sonra tespit edilecek) | 3 |
| Tarayıcı ve ekran otomasyonu | 3 |
| Dış AI sağlayıcı adaptörleri | 2, yönetici onayıyla |

### Çıkış kriterleri

Aşağıdaki senaryoların tamamı otomatik testle geçmelidir:

1. Telefondan verilen "Raporlar klasöründeki Excel'leri özetle" komutu, Windows'ta rapor üretir ve özet telefonda görünür.
2. Relay veritabanı ve trafik kaydı incelendiğinde komut, dosya adı veya içerik düz metin olarak bulunmaz.
3. Ele geçirilmiş relay simülasyonunda sahte komut, sahte onay ve tekrar oynatılan onay reddedilir.
4. Allowlist dışındaki klasöre erişim reddedilir ve denetim kaydına yazılır.
5. AI sağlayıcısı yokken kural tabanlı komutlar çalışır.
6. SECURITY.md'deki S1–S14 ve S16 kontrollerinin testleri yeşildir.

## Faz 2 — ERP ve Uzman Ajanlar (≈6 hafta)

- ⬜ `erp-core` ve `MockErpConnector`
- ⬜ ASEDEN connector (keşifte seçilen yöntemle)
- ⬜ Rapor dışa aktarma yolu (yedek)
- ⬜ Satınalma, AS9100 Kalite ve Yönetim Raporlama ajanları
- ⬜ Sesli komut (cihaz üzerinde)
- ⬜ Zamanlanmış görevler
- ⬜ İkinci telefon desteği

## Faz 3 — E-posta ve Bilgisayar Kontrolü (≈6 hafta)

- ⬜ Outlook sürüm tespiti ve entegrasyon yöntemi (ADR)
- ⬜ E-posta ajanı (gönderme işlemi `critical` olarak sınıflanır)
- ⬜ Tarayıcı otomasyonu
- ⬜ Uygulama allowlist'i
- ⬜ Ekran yardımı
- ⬜ Windows Hizmeti değerlendirmesi

## Faz 4 — Kontrollü Yazma, Ölçek ve Denetim

- ⬜ ERP kontrollü yazma
- ⬜ 4-göz onayı
- ⬜ Çoklu organizasyon
- ⬜ Harici penetrasyon testi ve kripto protokol incelemesi
