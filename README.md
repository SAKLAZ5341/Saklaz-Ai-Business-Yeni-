# SAKLAZ AI

Windows ajanı, Android uygulaması ve şirket kontrolündeki bir aktarım sunucusundan oluşan, ASEDEN ERP ile salt okunur entegre olan kişisel ve kurumsal AI ajan ekosistemi.

> **Durum:** Faz 0 tamamlandı, Faz 1 planı onay bekliyor. Henüz uygulama kodu yoktur.

## Belgeler

| Belge | İçerik |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Teknik mimari, teknoloji seçimleri, klasör yapısı, veritabanı tasarımı |
| [SECURITY.md](SECURITY.md) | Güven modeli, eşleştirme, uçtan uca şifreleme, onay kriptografisi, kontrol tablosu |
| [ROADMAP.md](ROADMAP.md) | Fazlar, MVP kapsamı, çıkış kriterleri |
| [docs/FAZ0-RAPOR.md](docs/FAZ0-RAPOR.md) | Faz 0 sonuçları ve bekleyen kararlar |
| [docs/FAZ1-PLAN.md](docs/FAZ1-PLAN.md) | Faz 1 (MVP) ayrıntılı planı — onay bekliyor |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Teknik gereksinimler |
| [docs/RISKS.md](docs/RISKS.md) | Risk kaydı |
| [docs/discovery/ASEDEN-KESIF.md](docs/discovery/ASEDEN-KESIF.md) | ASEDEN keşif planı ve entegrasyon seçenekleri |

## Keşif Araçları (salt okunur)

| Araç | Açıklama |
|---|---|
| `tools/discovery/aseden-pg-katalog.sql` | ASEDEN PostgreSQL katalog keşfi. ASEDEN yöneticisi tarafından çalıştırılır. |
| `tools/discovery/windows-envanter.ps1` | Hedef Windows bilgisayar envanteri. |
