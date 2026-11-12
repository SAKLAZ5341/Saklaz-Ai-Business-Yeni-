# Mimari Karar Kayıtları (ADR)

Her önemli ve geri dönüşü zor karar burada kaydedilir. Bir kararı değiştirmek için mevcut kayıt silinmez; yeni bir ADR yazılır ve eskisi "yerine geçti" olarak işaretlenir.

## Kayıtlar

| # | Başlık | Durum |
|---|---|---|
| 0001 | Relay sunucu "kör aktarıcı"dır; içerik görmez | Önerildi |
| 0002 | Telefon ile Windows arası Noise_KK + Ed25519 imzalı uçtan uca şifreleme | Önerildi |
| 0003 | Ajan yalnızca eşleştirilmiş cihazların imzaladığı komutları çalıştırır | Önerildi |
| 0004 | Dış AI sağlayıcıları varsayılan kapalı; `confidential` veri asla dışarı gönderilmez | Önerildi |
| 0005 | ASEDEN connector, keşif tamamlanmadan yazılmaz | Önerildi |
| 0006 | Outlook entegrasyonu MVP dışıdır | Kabul edildi (proje sahibi, 2026-11-12) |

ADR 0001–0005 kayıtlarının ayrıntılı gerekçeleri ARCHITECTURE.md ve SECURITY.md içindedir. Proje sahibi onayladığında bu kayıtlar "Kabul edildi" durumuna geçer ve ayrı dosyalara bölünür.
