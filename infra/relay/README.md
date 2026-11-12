# Relay kurulumu (TASLAK)

> **Durum:** Sprint 2'de yazıldı, **çalıştırılmadı**. Geliştirme ortamında Docker daemon'ı yok.
> Kurulum ve sıkılaştırma Sprint 5'te, IT ile birlikte ve FAZ1-PLAN §9'a göre doğrulanacak.

Her çalışma alanı ayrı bir kurulumdur:

| Alan | Kurulum yeri |
|---|---|
| PERSONAL | Sizin VPS'iniz |
| BUSINESS | Şirket DMZ sanal makinesi |

Gizli bilgiler `secrets/` klasöründe tutulur ve **repoya girmez** (`.gitignore`):

| Dosya | İçerik | Üretim |
|---|---|---|
| `jwt_private.pem` / `jwt_public.pem` | Ed25519 anahtar çifti | `openssl genpkey -algorithm ed25519` |
| `mfa_key.hex` | 32 rastgele bayt (hex) | `openssl rand -hex 32` |
| `db_password` | Veritabanı parolası | — |
| `database_url` | `postgresql://saklaz:<parola>@db:5432/saklaz` | — |

Dışarıya yalnızca **443** portu açılır. Veritabanı, internete çıkışı olmayan iç ağdadır.
