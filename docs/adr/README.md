# Mimari Karar Kayıtları (ADR)

Her önemli ve geri dönüşü zor karar burada kaydedilir. Bir kararı değiştirmek için mevcut kayıt silinmez; yeni bir ADR yazılır ve eskisi "yerine geçti" olarak işaretlenir.

## Kayıtlar

| # | Başlık | Durum |
|---|---|---|
| 0001 | Relay sunucu "kör aktarıcı"dır; içerik görmez | Kabul edildi (proje sahibi, 2026-11-12) |
| 0002 | Telefon ile Windows arası Noise_KK + Ed25519 imzalı uçtan uca şifreleme | Kabul edildi (proje sahibi, 2026-11-12) |
| 0003 | Ajan yalnızca eşleştirilmiş cihazların imzaladığı komutları çalıştırır | Kabul edildi (proje sahibi, 2026-11-12) |
| 0004 | Dış AI sağlayıcıları varsayılan kapalı; `confidential` veri asla dışarı gönderilmez | Kabul edildi (proje sahibi, 2026-11-12) |
| 0005 | ASEDEN connector, keşif tamamlanmadan yazılmaz | Kabul edildi (proje sahibi, 2026-11-12) |
| 0006 | Outlook entegrasyonu MVP dışıdır | Kabul edildi (proje sahibi, 2026-11-12) |
| 0007 | Çevrimdışı alıcıya mühürlü zarf; sınırlı ileri gizlilik kabulü | Önerilecek (Faz 1, Sprint 1) |
| 0008 | Noise ve libsodium uygulama seçimi (TS ve Dart) | Önerilecek (Faz 1, Sprint 1) |
| 0009 | Relay şirket içi DMZ sanal makinesinde, yalnızca 443 açık | Kabul edildi (proje sahibi, 2026-11-12) |
| 0010 | FCM yalnızca içeriksiz uyandırma sinyali | Kabul edildi (proje sahibi, 2026-11-12) |

Gerekçeler ARCHITECTURE.md, SECURITY.md ve docs/FAZ1-PLAN.md içindedir. Kayıtlar Faz 1, Sprint 1'de ayrı dosyalara bölünecek.
