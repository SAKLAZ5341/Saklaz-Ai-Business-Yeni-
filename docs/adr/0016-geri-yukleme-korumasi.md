# ADR-0016: Geri yükleme (rollback) koruması

- **Durum:** Kabul edildi (proje sahibi şartı, 2026-11-12). Sprint 2'de uygulanıyor.
- **Ayrıntı:** SECURITY.md §20

## Karar
Ajan, veritabanının **dışında** monoton artan bir durum dönemi (epoch) tutar. Windows'ta bu değer DPAPI korumalı kasada saklanır ve yedeğe dahil edilmez. Sayaç yazmalarıyla birlikte artar.

Başlangıçta veritabanındaki dönem kasadakinden eskiyse geri yükleme tespit edilir. Bu durumda:
- Geri yükleme tabanı şimdiki zaman olarak ayarlanır.
- Tabandan önce zaman damgalı tüm mesajlar reddedilir.
- Cihaz listesi yeniden senkronize edilir.
- Olay denetim kaydına yazılır.

## Kalan risk
Veritabanı ve kasa birlikte eski haline döndürülebilir (yerel yönetici yetkisi gerekir). Bu durum, uç cihazın ele geçirilmesi kapsamındadır (SECURITY.md V4).
