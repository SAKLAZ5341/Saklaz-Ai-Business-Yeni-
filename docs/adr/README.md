# Mimari Karar Kayıtları (ADR)

Her önemli ve geri dönüşü zor karar burada kaydedilir. Bir karar değiştiğinde mevcut kayıt silinmez; yeni bir ADR yazılır ve eskisi "yerine geçti" olarak işaretlenir.

| # | Başlık | Durum |
|---|---|---|
| 0001 | Relay sunucu "kör aktarıcı"dır; içerik görmez | Kabul edildi (proje sahibi, 2026-11-12) |
| 0002 | Telefon ile Windows arası Noise_KK ve Ed25519 imzalı uçtan uca şifreleme | Kabul edildi (proje sahibi, 2026-11-12) |
| 0003 | Ajan yalnızca eşleştirilmiş cihazların imzaladığı komutları çalıştırır | Kabul edildi (proje sahibi, 2026-11-12) |
| 0004 | Dış AI sağlayıcıları varsayılan olarak kapalı; `confidential` veri asla dışarı gönderilmez | Kabul edildi (proje sahibi, 2026-11-12) |
| 0005 | ASEDEN connector, keşif tamamlanmadan yazılmaz | Kabul edildi (proje sahibi, 2026-11-12) |
| 0006 | Outlook entegrasyonu MVP dışıdır | Kabul edildi (proje sahibi, 2026-11-12) |
| [0007](0007-cevrimdisi-muhurlu-zarf.md) | Çevrimdışı alıcıya mühürlü zarf; sınırlı ileri gizlilik | Önerildi (Sprint 1) |
| [0008](0008-kripto-kutuphanesi-ve-noise.md) | libsodium 0.8.4; kendi Noise_KK durum makinemiz; BLAKE2s yerine BLAKE2b | Önerildi (Sprint 1) |
| 0009 | Relay şirket içi DMZ sanal makinesinde, yalnızca 443 portu açık | Kabul edildi (proje sahibi, 2026-11-12) |
| 0010 | FCM yalnızca içeriksiz uyandırma sinyali için kullanılır | Kabul edildi (proje sahibi, 2026-11-12) |
| [0011](0011-ayri-onay-anahtari.md) | Telefonda komut ve onay anahtarlarının ayrılması; onayın işlemi tam kapsaması | Önerildi (Sprint 1) |
| [0012](0012-zaman-ve-sayi-temsili.md) | Tam sayı zaman damgaları, imzalı ömür, kayan pencereli sayaç | Önerildi (Sprint 1) |
| [0013](0013-calisma-alanlari.md) | PERSONAL ve BUSINESS çalışma alanları | Kabul edildi (proje sahibi, 2026-11-12) |
| [0014](0014-imzali-cihaz-listesi.md) | İmzalı cihaz listesi ve telefon–bilgisayar güven bağları | Kabul edildi (proje sahibi, 2026-11-12) |
| [0015](0015-kurtarma.md) | Üç katmanlı kurtarma; bağımsız güvenlik testi şartı | Kabul edildi (proje sahibi, 2026-11-12) |
| [0016](0016-geri-yukleme-korumasi.md) | Geri yükleme (rollback) koruması | Kabul edildi (proje sahibi, 2026-11-12) |

ADR 0001–0006, 0009 ve 0010'un gerekçeleri ARCHITECTURE.md, SECURITY.md ve docs/FAZ1-PLAN.md içindedir.
