# SAKLAZ AI

Windows ajanı, Android uygulaması ve şirket kontrolündeki bir aktarım sunucusundan oluşan, ASEDEN ERP ile salt okunur entegre olan kişisel ve kurumsal AI ajan ekosistemi.

> **Durum:** Faz 1, Sprint 2 tamamlandı: relay sunucusu, ajan güvenlik çekirdeği, imzalı cihaz listesi. Henüz kullanıcıya görünen bir uygulama yoktur. Bkz. [Sprint 2 raporu](docs/sprints/SPRINT-2-RAPOR.md).

## Belgeler

| Belge | İçerik |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Teknik mimari, teknoloji seçimleri, klasör yapısı, veritabanı tasarımı |
| [SECURITY.md](SECURITY.md) | Güven modeli, eşleştirme, uçtan uca şifreleme, onay kriptografisi, kontrol tablosu |
| [ROADMAP.md](ROADMAP.md) | Fazlar, MVP kapsamı, çıkış kriterleri |
| [docs/FAZ0-RAPOR.md](docs/FAZ0-RAPOR.md) | Faz 0 sonuçları ve bekleyen kararlar |
| [docs/FAZ1-PLAN.md](docs/FAZ1-PLAN.md) | Faz 1 (MVP) ayrıntılı planı (onaylandı) |
| [docs/sprints/](docs/sprints/) | Sprint raporları ve ham test çıktıları |
| [docs/MIMARI-v0.3-ONERI.md](docs/MIMARI-v0.3-ONERI.md) | v0.3 gerekçesi: çalışma alanları, cihaz listesi, kurtarma (kabul edildi) |
| [docs/KOD-IMZALAMA-ONERI.md](docs/KOD-IMZALAMA-ONERI.md) | Kod imzalama sertifikası ve mimari önerisi |
| [docs/adr/](docs/adr/) | Mimari karar kayıtları |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Teknik gereksinimler |
| [docs/RISKS.md](docs/RISKS.md) | Risk kaydı |
| [docs/discovery/ASEDEN-KESIF.md](docs/discovery/ASEDEN-KESIF.md) | ASEDEN keşif planı ve entegrasyon seçenekleri |

## Keşif Araçları (salt okunur)

| Araç | Açıklama |
|---|---|
| `tools/discovery/aseden-pg-katalog.sql` | ASEDEN PostgreSQL katalog keşfi. ASEDEN yöneticisi tarafından çalıştırılır. |
| `tools/discovery/windows-envanter.ps1` | Hedef Windows bilgisayar envanteri. |

## Geliştirme

Gereksinimler: Node.js 22 ve pnpm 10.

```
pnpm install --frozen-lockfile
pnpm run ci          # lint + ERP sınır kontrolü + tip denetimi + testler
pnpm run vectors     # çapraz platform test vektörlerini yeniden üretir
```

| Paket | İçerik |
|---|---|
| `packages/crypto` | libsodium üzerine kriptografi katmanı (Ed25519, X25519, AEAD, HKDF, Noise_KK, mühürlü zarf, SAS) |
| `packages/protocol` | Kanonik JSON, şemalar, imzalı mesajlar, işleme bağlı onay, tekrar oynatma koruması, doğrulama hattı |
| `packages/testkit` | YALNIZCA TEST: telefon simülatörü (üretim koduna girmesi CI'da engellenir) |
| `apps/agent` | Windows ajanı güvenlik çekirdeği: SQLCipher depo, denetim zinciri, rollback koruması, acil kilit, eşleştirme, relay istemcisi |
| `apps/relay` | Relay sunucusu (kör aktarıcı): hesap + TOTP, cihaz kimlik doğrulama, şifreli yönlendirme, kuyruk |
| `infra/relay` | Relay dağıtımı TASLAĞI (Docker Compose, Caddy) — henüz çalıştırılmadı |
| `apps/mobile/vector_check` | Dart uyumluluk testi (henüz çalıştırılmadı) |
