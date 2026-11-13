# Relay — TLS ve Üretim Dağıtım Güvenliği

> **Sürüm:** Sprint 3 A2, 2026-11-13
> **Kapsam:** PERSONAL (kişisel VPS) ve BUSINESS (şirket DMZ) relay kurulumları.
> **Durum:** Bu belgedeki Compose yapılandırması GitHub CI'da test edilir. **Gerçek bir sunucuda henüz uygulanmadı**; Sprint 5'te IT ile birlikte uygulanıp doğrulanacak. Aşağıdaki maddeler o kurulumun kontrol listesidir.
> **Dil kuralı:** Hiçbir madde mutlak güvenlik vaat etmez. Hepsi `SECURITY.md` §0'daki varsayımlara bağlıdır.

## 1. Relay'in güven modelindeki yeri

Relay **güvenilmeyen** taraftır. Mesaj içeriklerini göremez, çünkü içerikler uçtan uca şifrelidir. Komut da üretemez, çünkü komutlar telefonun cihaz anahtarıyla imzalanır. Bu yüzden relay sunucusunun tamamen ele geçirilmesi bile tek başına bilgisayarda komut çalıştırmaya yetmez (S4, S16).

Yine de relay şunları korur; dağıtım güvenliği bunlar içindir:

| Varlık | Ele geçirilirse |
|---|---|
| Hesaplar (Argon2id parola özetleri, şifreli TOTP sırları) | Çevrimdışı parola deneme. MFA anahtarı da çalınırsa TOTP sırları açılır. |
| JWT özel anahtarı | Relay'e bağlanma token'ı üretilebilir. Komut **üretilemez.** |
| Meta veri (kim, kiminle, ne zaman, ne boyutta) | Gizlilik kaybı |
| Kuyruktaki şifreli zarflar | Geciktirme ve engelleme (S23). İçerik okunamaz. |
| TLS özel anahtarı (`caddy_data` volume'u) | Ortadaki adam saldırısı. İçerik yine uçtan uca şifreli kalır. |

## 2. TLS

| Konu | Yapılandırma |
|---|---|
| Sonlandırma | Caddy (`caddy` servisi). Relay uygulaması TLS görmez; yalnızca iç ağda dinler. |
| Protokol | **Yalnızca TLS 1.3** (`protocols tls1.3`). TLS 1.2 ve altı reddedilir; CI'da `openssl s_client -tls1_2` ile test edilir. |
| Sertifika | Gerçek alan adında **ACME** (Let's Encrypt) ile otomatik alınır ve yenilenir. Port 80 kapalıysa Caddy TLS-ALPN-01 doğrulamasını 443 üzerinden yapar. ACME iletişim adresi `Caddyfile` genel bloğuna `email` satırıyla eklenir. |
| Şirket sertifikası (BUSINESS) | Şirket kendi sertifika yetkilisini kullanıyorsa ACME yerine `tls /etc/caddy/cert.pem /etc/caddy/key.pem` kullanılır. Dosyalar salt okunur bağlanır ve anahtar dosyası 0400 olur. |
| HSTS | `max-age=31536000; includeSubDomains`. `preload` bilinçli olarak **eklenmedi**: alan adının bütün alt alanları kalıcı olarak HTTPS'e bağlanır ve geri alınması aylar sürer. Bu, alan adı sahibinin kararıdır. |
| Başlıklar | `Server` kaldırıldı; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; relay yanıtlarında `Cache-Control: no-store`. |
| Yol filtresi | Yalnızca `/v1/*`, `/healthz`, `/readyz` relay'e iletilir; geri kalan her şey 404. |
| İstemci IP'si | Caddy, istemcinin gönderdiği `X-Forwarded-For` değerini **yok sayar** ve kendisi yazar. Relay yalnızca bir sekmeye güvenir (`SAKLAZ_TRUST_PROXY_HOPS=1`). Böylece IP başına hız sınırı sahte başlıkla atlatılamaz. Relay Caddy olmadan doğrudan açılırsa varsayılan değer `0`'dır (hiçbir başlığa güvenilmez). |
| Sertifika özel anahtarı | `caddy_data` volume'unda. Yedeklenmesi gerekmez (yeniden alınabilir); yedekleniyorsa **şifreli** yedeklenir. |
| Uygulamada sertifika sabitleme | Android uygulamasında sertifika veya açık anahtar sabitleme Sprint 4'te değerlendirilecek. İçerik zaten uçtan uca şifreli olduğu için sabitleme yalnızca meta veri ve erişilebilirlik içindir. |

## 3. Ağ

- Dışarıya açık **tek port: 443/tcp.** Relay (8080) ve PostgreSQL (5432) portları yayımlanmaz; CI'da `docker inspect` ile doğrulanır.
- Veritabanı, `internal: true` ağdadır: internete çıkışı yoktur ve yalnızca relay ona ulaşır.
- İki çalışma alanı **ayrı sunuculardadır.** Aynı sunucuda test edildiğinde bile ağları ayrıdır; bir kurulumun relay'i diğerinin veritabanına ulaşamaz (CI'da test edilir).
- **Uyarı (ufw kullanıcıları):** Docker, yayımlanan portlar için kendi iptables kurallarını yazar ve **ufw kurallarını atlar.** Bu yüzden Compose dosyasına 443 dışında port **eklenmemelidir.** Sunucu güvenlik duvarı ayrıca yalnızca 443'ü (ve yönetim için kısıtlı kaynaktan SSH'ı) açmalıdır.
- Şirket DMZ'si: içeriden (Windows ajanları) relay'e **yalnızca giden** 443. Relay'den şirket iç ağına hiçbir bağlantı yoktur ve gerekmez.

## 4. Konteyner sıkılaştırma (uygulandı, CI'da test ediliyor)

| Önlem | relay | db | caddy |
|---|---|---|---|
| Root olmayan kullanıcı | ✅ uid 1000 | Giriş betiği root başlar, `postgres`'e geçer | Resmî imaj varsayılanı |
| Salt okunur kök dosya sistemi | ✅ | ✅ (veri volume'da, soket tmpfs'te) | ✅ |
| Bütün Linux yetkileri kaldırıldı (`cap_drop: ALL`) | ✅ (CapEff = 0, test edilir) | Yalnızca CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID | Yalnızca NET_BIND_SERVICE |
| `no-new-privileges` | ✅ | ✅ | ✅ |
| Sağlık denetimi | `/healthz` | `pg_isready` | yönetim API'si (yalnızca 127.0.0.1) |
| Yeniden başlatma | `unless-stopped` | `unless-stopped` | `unless-stopped` |
| Kaynak sınırı | 512 MB bellek, 256 süreç | — | — |
| Günlük döndürme | 5 × 10 MB | 5 × 10 MB | 5 × 10 MB |
| İmajda | Yalnızca `dist`, `migrations`, üretim `node_modules`. TypeScript kaynağı, test, npm/yarn/corepack **yok.** | Resmî imaj | Resmî imaj |

## 5. Gizli bilgi yönetimi

- Üretim: `infra/relay/scripts/init-secrets.sh`. Var olan dosyaların **üzerine yazmaz.** Değerleri ekrana veya günlüğe yazmaz.
- Gizli bilgiler **dosya** olarak bağlanır (`/run/secrets`). Ortam değişkeninde düz değer bulunursa relay başlamaz. Ortam değişkenleri `docker inspect`, `/proc/*/environ` ve hata dökümlerinde görünür; dosyalar görünmez.
- Gizli değerler imaja girmez. Derleme bağlamı `.dockerignore` **izin listesiyle** sınırlıdır. CI'da bir **kanarya testi** repoda gizli dosya bırakıp imajı yeniden derler ve imajın tamamında kanarya değerini arar; bulunmaz.
- Günlükler: CI'da bütün konteyner günlüklerinde parola, TOTP sırrı, MFA anahtarı, JWT özel anahtarı, veritabanı parolası ve token aranır; bulunmaz. Relay istek günlüklerinde başlık ve gövde yoktur. Caddy erişim günlükleri `Authorization` başlığını gizler.
- **Bilinen sınır:** Compose'un (Swarm olmayan) dosya tabanlı secrets özelliği dosyaları sunucudaki izinleriyle bağlar; tmpfs veya sahiplik/izin eşlemesi yapmaz. Bu yüzden dosya izinleri sunucuda ayarlanır (bkz. `init-secrets.sh`). Daha sıkı seçenekler Sprint 5'te IT ile değerlendirilecek: Docker Swarm secrets, Podman secrets veya bir sır yöneticisi (ör. Vault).
- **`docker` grubu root'a eşdeğerdir.** Bu gruba yalnızca sunucu yöneticileri alınmalıdır.

### Anahtar yenileme (rotasyon)

| Anahtar | Durum |
|---|---|
| Veritabanı parolası | Elle: `ALTER ROLE saklaz PASSWORD ...` + dosya güncellemesi + relay yeniden başlatma. Kesinti birkaç saniye. |
| JWT anahtar çifti | Elle: yeni çift + relay yeniden başlatma. **Bütün oturumlar düşer**, kullanıcılar yeniden giriş yapar. Komut güvenliği etkilenmez. |
| MFA anahtarı | **Henüz desteklenmiyor.** Yenileme, bütün TOTP sırlarının eski anahtarla çözülüp yeni anahtarla şifrelenmesini gerektirir. Araç S5'te. O zamana kadar anahtar kaybı = bütün kullanıcıların TOTP'yi yeniden kurması. |
| TLS sertifikası | Caddy otomatik yeniler. |

## 6. Sunucu (ana makine) kontrol listesi — Sprint 5'te IT ile

- [ ] Güncel ve desteklenen işletim sistemi, otomatik güvenlik güncellemeleri
- [ ] SSH yalnızca anahtarla, parola girişi kapalı, root girişi kapalı, kaynak IP kısıtlı
- [ ] Güvenlik duvarı: gelen yalnızca 443 (+ kısıtlı SSH)
- [ ] **NTP zorunlu.** Saat kayması TOTP girişlerini bozar (A1 raporu R-A1-3).
- [ ] Docker daemon: TCP soketi kapalı (yalnızca Unix soketi), `live-restore: true`, günlük döndürme
- [ ] İsteğe bağlı: Docker `userns-remap` veya rootless Docker
- [ ] Disk şifreleme: özellikle VPS'te (sağlayıcı erişimine karşı)
- [ ] Gizli bilgi klasörü 0700, sahibi root
- [ ] Yedekleme: günlük `pg_dump` ve gizli bilgi klasörü, **şifreli ve sunucu dışında**. Geri yükleme provası en az bir kez yapılır.
- [ ] İzleme: `/readyz` dış izleme, disk doluluğu, konteyner yeniden başlatma sayısı
- [ ] Denetim kaydı zinciri (`audit_meta`) için periyodik doğrulama (`verifyAuditMeta`; araç S5'te)

## 7. Güncelleme

1. Yeni imaj, etiketli bir commit'ten CI'da derlenir ve özetiyle (digest) kaydedilir. GitHub Packages'a (GHCR) yayımlama ve kaynak kanıtı A9'da gelecek. **Sunuculara otomatik dağıtım yapılmaz** (K4).
2. Veritabanı yedeği alınır.
3. `run --rm relay migrate` ile şema uygulanır.
4. `SAKLAZ_RELAY_IMAGE` yeni özete ayarlanır ve `up -d --wait` çalıştırılır. İsterseniz `SAKLAZ_MIGRATE=check` ile.
5. Geri dönüş: eski imaj **yeni şemayla** başlamaz (`MIGRATION_UNKNOWN`). Geri dönüş, yedekten geri yükleme ile yapılır. Bu bilinçli bir önlemdir: eski kodun yeni şemayı bozması engellenir.

## 8. Temel imajlar

Etiket + özet (digest) ile sabitlenmiştir. Etiket ileride başka bir imajı gösterse bile aynı imaj kullanılır. Özetler 2026-11-13'te CI'da çözüldü ve her CI çalışmasında yeniden yazdırılır.

| İmaj | Özet (çok mimarili dizin) | Nerede |
|---|---|---|
| `node:22.23.4-bookworm-slim` | `sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` | Dockerfile `ARG NODE_IMAGE` |
| `postgres:16.10-bookworm` | `sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74` | Compose `SAKLAZ_POSTGRES_IMAGE` |
| `caddy:2.10.2-alpine` | `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` | Compose `SAKLAZ_CADDY_IMAGE` |

Güvenlik yamaları için özetler planlı olarak güncellenir: Dependabot'un Docker desteği veya elle, CI yeşil olduktan sonra. Güvenlik açığı taraması ve SBOM A9'da eklenecek.
