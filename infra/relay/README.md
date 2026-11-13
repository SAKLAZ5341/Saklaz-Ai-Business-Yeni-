# Relay Kurulumu (Docker Compose)

> **Durum (Sprint 3 A2):** İmaj ve Compose kurulumu GitHub CI'da gerçek Docker ile otomatik olarak test edilir (`Docker — relay imajı ve Compose (A2)` işi): ilk kurulum, yeniden başlatma, veri kalıcılığı, migration, TOTP tekrar kullanımı, eşzamanlı giriş, yanlış anahtar ve eksik secret, çökme ve yeniden ayağa kalkma, veritabanı kopması, iki çalışma alanının izolasyonu ve TLS.
> **Gerçek bir sunucuda henüz kurulmadı.** Gerçek sunucu doğrulaması Sprint 5'te IT ile yapılacak. Üretim güvenliği ve TLS: [docs/deploy/RELAY-DAGITIM-GUVENLIGI.md](../../docs/deploy/RELAY-DAGITIM-GUVENLIGI.md).

## Çalışma alanları

Her çalışma alanı **ayrı bir kurulumdur**: ayrı sunucu, ayrı Compose projesi, ayrı veritabanı volume'u, ayrı ağ ve ayrı gizli bilgiler.

| Alan | Kurulum yeri | Proje adı | Relay kimliği |
|---|---|---|---|
| PERSONAL | Kişisel VPS | `saklaz-personal` | `saklaz-personal` |
| BUSINESS | Şirket DMZ sanal makinesi | `saklaz-business` | `saklaz-business` |

## Bileşenler

| Servis | Görev | Dışarıya açık mı? |
|---|---|---|
| `caddy` | TLS 1.3 sonlandırma, HSTS, yalnızca `/v1/*`, `/healthz`, `/readyz` | **Evet: yalnızca 443** |
| `relay` | Relay uygulaması; root değil (uid 1000), salt okunur dosya sistemi, bütün Linux yetkileri kaldırılmış | Hayır (yalnızca Caddy üzerinden) |
| `db` | PostgreSQL 16; veri `db_data` volume'unda | Hayır (internete çıkışı olmayan iç ağ) |

## Kurulum

```sh
# 1. Gizli bilgiler (sunucuda, root olarak). Var olan dosyaların üzerine YAZMAZ.
sudo infra/relay/scripts/init-secrets.sh /etc/saklaz/personal

# 2. Ortam dosyası (gizli değer İÇERMEZ)
cat > personal.env <<EOF
SAKLAZ_RELAY_ID=saklaz-personal
SAKLAZ_RELAY_DOMAIN=relay.ornek.com.tr
SAKLAZ_SECRETS_DIR=/etc/saklaz/personal
SAKLAZ_RELAY_IMAGE=saklaz-relay:<sürüm>
EOF

# 3. Başlatma
sudo docker compose -f infra/relay/docker-compose.yml -p saklaz-personal --env-file personal.env up -d --wait
```

`--wait`, üç servis de sağlıklı olana kadar bekler. `docker compose ps` her servis için `healthy` göstermelidir.

## Gizli bilgiler

| Dosya | İçerik | İzin |
|---|---|---|
| `db_password` | PostgreSQL parolası (hem `db` hem `relay` okur) | 0444, klasör 0700 |
| `jwt_private.pem` / `jwt_public.pem` | Ed25519 anahtar çifti (oturum token'ları) | 0400, sahibi uid 1000 |
| `mfa_key.hex` | TOTP sırlarını şifreleyen 32 baytlık anahtar | 0400, sahibi uid 1000 |

- Gizli bilgiler **imaja gömülmez** ve **ortam değişkeninde bulunmaz.** Konteynere `/run/secrets/` altında dosya olarak bağlanır. Ortamda `SAKLAZ_DB_PASSWORD`, `SAKLAZ_MFA_KEY`, `DATABASE_URL`, `PGPASSWORD` vb. tanımlıysa relay **başlamaz**.
- Bu klasör **şifreli olarak ve sunucu dışında yedeklenmelidir.** MFA anahtarı kaybolursa bütün kullanıcıların TOTP kaydı geçersiz olur.
- Relay açılışta MFA anahtarının bu veritabanına ait olduğunu ve JWT anahtarlarının aynı çifte ait olduğunu doğrular. Yanlış anahtarla **başlamaz** (`MFA_KEY_MISMATCH`, `JWT_KEYPAIR_MISMATCH`).

## Şema (migration)

- Varsayılan (`SAKLAZ_MIGRATE=apply`): relay açılışta bekleyen şema dosyalarını uygular. Her dosya ayrı bir işlem içinde uygulanır ve SHA-256 özetiyle `schema_migrations` tablosuna yazılır.
- **Kontrollü yükseltme (üretimde önerilen):**
  1. Veritabanı yedeği alınır (aşağıda).
  2. `docker compose ... run --rm relay migrate`: yalnızca şemayı uygular ve çıkar.
  3. Relay `SAKLAZ_MIGRATE=check` ile başlatılır: bekleyen şema varsa başlamaz, hiçbir şeyi değiştirmez.
- Uygulanmış bir dosyanın içeriği değişmişse (`MIGRATION_MODIFIED`) veya veritabanında bu sürümün bilmediği bir dosya varsa (`MIGRATION_UNKNOWN`, eski imaja dönüş) relay **başlamaz**.

## İşletim

| İşlem | Komut |
|---|---|
| Durum | `docker compose -p saklaz-personal ps` |
| Günlükler (JSON, döndürülür: 5 × 10 MB) | `docker compose -p saklaz-personal logs -f relay` |
| Hazır olma | `curl https://relay.ornek.com.tr/readyz` → veritabanı kopuksa 503 |
| Yeniden başlatma | `docker compose -p saklaz-personal restart relay` |
| Veritabanı yedeği | `docker compose -p saklaz-personal exec -T db pg_dump -U saklaz -Fc saklaz > yedek.dump` |
| Durdurma (veri korunur) | `docker compose -p saklaz-personal down` |
| **Veriyi silerek** kaldırma | `docker compose -p saklaz-personal down -v` (**geri alınamaz**) |

## Davranışlar

- **Otomatik yeniden başlatma:** Bütün servisler `restart: unless-stopped`. Relay süreci çökerse veya açılış denetimi başarısız olursa konteyner yeniden başlar.
- **Sağlık denetimi:** `relay` için `/healthz` (süreç canlı), `db` için `pg_isready`, `caddy` için yönetim API'si. Caddy, relay sağlıklı olmadan başlamaz; relay, veritabanı sağlıklı olmadan başlamaz.
- **Veritabanı kopması:** Relay çökmez ve yeniden başlamaz. `/readyz` 503 döner, istekler ayrıntısız `503 UNAVAILABLE` alır. Veritabanı geri gelince relay kendiliğinden toparlanır.
- **Düzgün kapanma:** SIGTERM'de yeni bağlantı alınmaz, açık bağlantılar kapatılır, veritabanı havuzu kapanır (en fazla 10 sn).
