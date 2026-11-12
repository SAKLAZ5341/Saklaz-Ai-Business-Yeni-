# ADR-0013: PERSONAL ve BUSINESS çalışma alanları

- **Durum:** Kabul edildi (proje sahibi, 2026-11-12)
- **Ayrıntı:** MIMARI-v0.3-ONERI.md §2.1, SECURITY.md §17

## Karar
Her çalışma alanı ayrı bir güven alanıdır. Her alanın şunları ayrıdır:
- relay örneği (PERSONAL: kişisel VPS; BUSINESS: şirket DMZ)
- cihaz listesi
- denetim kaydı
- telefon anahtar setleri
- yerel veritabanları
- FCM projeleri

İmzalı başlığa `ws` alanı eklenir ve onay özeti de bu alanı kapsar. Bir ajan kurulumu yalnızca tek bir alana aittir.
Alanlar arası aktarım Faz 1'de yoktur (Faz 2).

## Sonuçlar
- Şirket BT'si, kişisel alanın meta verisine dahi erişemez. Bu, ayrı relay kullanılmasının bir sonucudur.
- Telefon, iki alanın ortak noktasıdır. Telefonun işletim sistemi ele geçirilirse iki alan birden etkilenebilir (SECURITY.md V4).
