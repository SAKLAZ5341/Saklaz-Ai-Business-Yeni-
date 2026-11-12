# ADR-0012: İmzalı veride zaman ve sayı temsili

- **Durum:** Önerildi (Sprint 1). Protokolde uygulandı.
- **Tarih:** 2026-11-12

## Karar
1. **Zaman alanları** Unix epoch milisaniye cinsinden **tam sayıdır** (`ts`, `exp`, `issuedAt`), ISO metin değildir.
   - Gerekçe: Tarih metinlerinin ayrıştırılması diller arasında farklı davranabilir.
2. **İmzalı ömür:** Her mesaj başlığında imzalı bir `exp` alanı bulunur. Her mesaj tipinin azami ömrü vardır:
   - Kuyruklanabilir tipler: `cmd.create`, `cmd.cancel`, `device.revoke`, `agent.lockdown` → en çok 72 saat.
   - Etkileşimli tipler → en çok 10 dakika.
   - Relay bu süreleri uzatamaz, çünkü başlık imzalıdır (testli).
3. **Sayılar:** İmzalanan JSON'da yalnızca güvenli tam sayılara izin verilir (RFC 8785'in katı alt kümesi). Kesirli değerler (ör. tutar) kuruş cinsinden tam sayı veya ondalık metin olarak taşınır.
4. **Tekrar oynatma koruması:** Katı artan sayaç yerine **kayan pencereli sayaç** (1024) kullanılır.
   - Gerekçe: Kuyruktaki eski bir mesaj, daha yeni bir canlı mesajdan sonra gelebilir. Kayan pencere bu mesajı kaybetmez, ama hiçbir mesajı iki kez işletmez (özellik tabanlı testle doğrulandı).
