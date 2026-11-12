# ASEDEN ERP — Keşif Planı ve Bulgular

> **Sürüm:** v0.1 (Faz 0), 2026-11-12

## 0. Mevcut Durum (dürüst özet)

| Soru | Bilinen | Kaynak | Doğrulandı mı? |
|---|---|---|---|
| Veritabanı motoru | PostgreSQL'e geçildiği belirtildi | Proje sahibinin beyanı | ❌ Hayır |
| Firestore kullanımı | Artık kullanılmadığı belirtildi | Proje sahibinin beyanı | ❌ Hayır |
| Resmî veya mevcut API | Bilinmiyor | — | ❌ Hayır |
| Barındırma yeri (ASEDEN) | Bilinmiyor | — | ❌ Hayır |
| Kimlik ve yetki modeli | Bilinmiyor | — | ❌ Hayır |

### Bu oturumda neden doğrulama yapılamadı?

SAKLAZ AI geliştirme ortamının ASEDEN'in kaynak koduna, sunucusuna, veritabanına veya Firebase projesine **hiçbir erişimi yoktur**. Ayrıca GitHub reposuna da şu anda erişilemiyor. Bu yüzden "üretim bağlantılarını inceleme" adımı bu ortamdan yapılamaz.

Bu bilinçli olarak böyle bırakılmıştır. ASEDEN'e erişim, ancak sahibinin aşağıdaki yöntemlerden birini açıkça onaylamasıyla verilir.

Aşağıdaki plan, doğrulamanın **hiçbir canlı veriyi değiştirmeden** nasıl yapılacağını tanımlar. Her adımın sonucu §5'teki bulgu tablosuna işlenecektir. Bulgu tablosu doldurulmadan `packages/erp-aseden` paketine bağlantı kodu yazılmaz.

## 1. İlkeler

1. **Yazma yok.** Hiçbir adım INSERT, UPDATE, DELETE, DDL, migration, Firestore yazması, yapılandırma değişikliği veya servis yeniden başlatma içermez.
2. **Önce kaynak kod, sonra çalışan sistem.** En güvenli kanıt ASEDEN'in kaynak kodu ve dağıtım yapılandırmasıdır. Canlı sisteme dokunmak, ancak koddan kesin sonuç çıkmazsa gerekir.
3. **Katalog var, veri yok.** Veritabanı keşfinde yalnızca sistem kataloğu sorgulanır (şema, tablo adları, istatistikler). İş verisi satırları okunmaz.
4. **Gizli bilgiler maskelenir.** Bağlantı dizgileri, parolalar ve servis hesabı anahtarları hiçbir rapora, sohbete veya repoya yazılmaz. Yalnızca "host türü / port / veritabanı adı / kullanıcı adı var mı?" düzeyinde not alınır.
5. **İşlemi ASEDEN yetkilisi yapar.** Canlı sistemdeki her adımı ASEDEN'in yöneticisi kendisi çalıştırır veya açıkça onaylar. Çıktıları maskeleyerek paylaşır.

## 2. Keşif Adımları

### Adım A — Kaynak kod ve yapılandırma incelemesi (risk: yok)

ASEDEN kaynak kodu bu oturuma **salt okuma** yetkisiyle eklenirse bu adımı ben yapabilirim. Yetki, örneğin GitHub'da ilgili repoya okuma izni verilerek sağlanabilir. Aranacak kanıtlar:

| Aranacak | Ne kanıtlar? |
|---|---|
| `package.json` / bağımlılıklar: `pg`, `postgres`, `prisma`, `drizzle`, `typeorm`, `sequelize`, `knex` | PostgreSQL istemcisi kullanımı |
| `firebase`, `firebase-admin`, `@google-cloud/firestore` bağımlılıkları ve `getFirestore`, `collection(`, `doc(` çağrıları | Firestore'un hâlâ kodda olup olmadığı |
| Aynı veri için hem Firestore hem PG yazımı | **Çift yazma.** Geçiş tamamlanmamış olabilir. |
| `.env.example`, `docker-compose*.yml`, dağıtım dosyaları (Cloud Run, Vercel, Firebase Hosting, PM2, systemd) | Üretimde hangi bağlantı değişkenlerinin beklendiği |
| `DATABASE_URL`, `PGHOST`, `FIREBASE_*`, `GOOGLE_APPLICATION_CREDENTIALS` kullanımları | Hangi bağlantıların fiilen okunduğu |
| Migration klasörleri (`migrations/`, `prisma/migrations`, `drizzle/`) | Şemanın tanımı ve geçiş geçmişi |
| HTTP rota tanımları (Express/Fastify/Next.js API, Cloud Functions), OpenAPI/Swagger dosyaları | Mevcut API'nin varlığı ve kapsamı |
| Kimlik doğrulama (Firebase Auth, JWT, oturum) ve rol kontrolleri | API'ye nasıl yetkili okuma yapılabileceği |

**Çıktı:** Kodun beklediği veritabanı ve kodun sunduğu API listesi. Kod "beklenen" durumu gösterir, "çalışan" durumu değil. Bu yüzden Adım B ile teyit gerekir.

### Adım B — Çalışan sistemin bağlantılarını gözlemleme (risk: çok düşük, yalnızca okuma)

ASEDEN sunucusunda ASEDEN yöneticisi şu adımları uygular:

| Kontrol | Linux | Windows |
|---|---|---|
| Uygulama sürecinin açık bağlantıları | `sudo ss -tnp \| grep <süreç>` | `Get-NetTCPConnection -OwningProcess <PID>` |
| PostgreSQL'e (genelde :5432) aktif bağlantı var mı? | yukarıdaki çıktıda `:5432` | aynı |
| Google API'lerine (`firestore.googleapis.com`) bağlantı var mı? | `ss` çıktısındaki 443 hedeflerinin DNS çözümü | aynı |
| Ortam değişkenlerinin **yalnızca adları** | `sudo cat /proc/<PID>/environ \| tr '\0' '\n' \| cut -d= -f1` | Servis yapılandırması |

Not: Ortam değişkeni **değerleri** paylaşılmaz; yalnızca adları paylaşılır.

ASEDEN yönetilen bir platformda (Vercel, Cloud Run, Firebase vb.) çalışıyorsa bu adımın yerine platform panelindeki ortam değişkeni **adları** ve bağlı servisler incelenir.

### Adım C — Firestore'un gerçekten kullanılmadığının teyidi (risk: yok)

Firebase Console ve Google Cloud Console'da şu ölçümler incelenir:

- Firestore → Usage: Son 30 günün **okuma, yazma ve silme** sayıları.
- Cloud Monitoring: `firestore.googleapis.com/document/write_count` ve `read_count` ölçümleri.

**Yorum:**

- Yazma sayısı **sıfır değilse**, bir modül hâlâ Firestore'a yazıyordur. Bu durum geçişin tamamlanmadığını gösterir ve **kritik bulgudur**.
- Okuma var ama yazma yoksa, bazı ekranlar eski veriyi okumaya devam ediyor olabilir.
- Hiçbir şeye dokunulmaz; Firestore verisi silinmez veya kapatılmaz. Bu karar ASEDEN sahibine aittir ve bu projenin kapsamı dışındadır.

### Adım D — PostgreSQL katalog keşfi (risk: düşük, salt okunur)

**Ön koşul:** Bu adım için ASEDEN yöneticisinin **ayrı, salt okunur bir keşif rolü** oluşturmasını öneriyoruz. Bu rol yalnızca katalog erişimine sahip olmalıdır. Alternatif olarak yönetici sorguları kendi hesabıyla çalıştırabilir.

> ⚠️ Rol oluşturmak, ASEDEN veritabanında bir değişikliktir (veri değil, yetki değişikliği). Bunu yapıp yapmamak ASEDEN sahibinin kararıdır. Bu proje bu adımı kendisi yapmaz.

**Sorgular:** `tools/discovery/aseden-pg-katalog.sql` dosyasındadır. Yönetici bu sorguları `psql` ile çalıştırır. Sorguların özellikleri:

- Oturumu `default_transaction_read_only = on` ile açar.
- Yalnızca `pg_catalog`, `information_schema` ve `pg_stat_*` görünümlerini okur.
- İş tablolarından tek bir satır bile okumaz.
- Şu bilgileri üretir:
  - Sürüm.
  - Veritabanı ve şema listesi.
  - Tablo ve görünüm adları ile tahmini satır sayıları.
  - Sütun adları ve tipleri.
  - Yabancı anahtarlar.
  - **Son yazma etkinliği:** `pg_stat_user_tables` içindeki `n_tup_ins/upd/del` değerleri ve `last_autoanalyze`.
- Son yazma etkinliği, **bu veritabanının gerçekten canlı veritabanı olup olmadığının** en güçlü kanıtıdır. İstatistikler sürekli artıyorsa uygulama buraya yazıyor demektir.

**Çıktının paylaşımı:** Tablo ve sütun adları ticari açıdan hassas sayılabilir. Çıktı sohbete yapıştırılmaz; dosya olarak ve gizli tutularak paylaşılır.

### Adım E — API kullanılabilirliği (risk: yok)

Adım A sonucunda bir API bulunduysa şu sorular yanıtlanır:

1. Gereken alanları kapsıyor mu? Alanlar: satınalma talepleri, teklifler, siparişler, tedarikçiler, stok, AS9100 kayıtları ve raporlar.
2. Salt okunur yetkiyle bir **servis hesabı** tanımlanabiliyor mu?
3. Sayfalama, filtreleme ve "şu tarihten beri değişenler" gibi sorgular destekleniyor mu?
4. Hız sınırı var mı? Ağdan erişim nasıl? Ajan yerel ağda mı, ASEDEN bulutta mı?

## 3. Entegrasyon Seçenekleri (ASEDEN'e müdahale düzeyine göre)

| # | Yöntem | ASEDEN'de gereken değişiklik | Güvenlik | Bakım | Not |
|---|---|---|---|---|---|
| 1 | **Mevcut ASEDEN API'si + salt okunur servis hesabı** | Yalnızca bir kullanıcı veya servis hesabı tanımı | ✅ En iyi: iş kuralları ve yetkiler ASEDEN'de kalır | ✅ Şema değişikliklerinden etkilenmez | API varsa **önerilen** |
| 2 | **Salt okunur PostgreSQL rolü + SAKLAZ'a özel görünümler (`saklaz_ro` şeması)** | Bir rol ve birkaç görünüm (DDL). Veri değişmez. | ✅ İyi: yalnızca görünümler açılır, kişisel veri sütunları dışarıda bırakılabilir | 🟨 Görünümler, ASEDEN şeması değişince güncellenmeli | API yoksa **önerilen** |
| 3 | Salt okunur rol, doğrudan tablolarda `SELECT` | Yalnızca rol ve yetki | 🟨 Orta: gereğinden fazla tablo görünür | ❌ Şema değişikliği connector'ı bozar | Geçici, önerilmez |
| 4 | **Okuma replikası veya mantıksal replikasyonla ayrı bir PostgreSQL** | Replikasyon yapılandırması | ✅ İyi: canlı veritabanına hiç yük binmez, tam izolasyon | 🟨 Altyapı gerektirir | Uzun vadede 1 veya 2 ile birlikte ideal |
| 5 | **ASEDEN'in kendi rapor çıktıları (Excel/CSV) → izinli klasör** | Yok (mevcut dışa aktarma kullanılır) | ✅ ASEDEN'e hiç dokunulmaz | 🟨 Elle veya zamanlanmış, gecikmeli veri | **Erişim izni çıkmazsa yedek plan.** Faz 2'de hemen başlanabilir. |

### Kabul edilmeyecek yöntemler

- ASEDEN uygulamasının kendi veritabanı kullanıcısını veya parolasını kullanmak. Bu kullanıcının yazma yetkisi vardır; K8 ihlalidir.
- Firestore Admin SDK servis hesabı kullanmak. Bu hesap tam okuma ve yazma yetkisi verir.
- ASEDEN web arayüzünü ekran kazıma (scraping) ile birincil kaynak olarak kullanmak. Kırılgandır ve denetlenemez.
- ASEDEN koduna SAKLAZ için uç nokta (endpoint) eklemek. Bu ancak ASEDEN sahibinin kendi geliştirme süreciyle ve ayrı bir kararla yapılabilir.

### Öneri

Seçim Adım A–E'nin sonuçlarına göre yapılmalıdır:

- **API varsa ve kapsam yeterliyse:** Seçenek 1.
- **API yoksa veya kapsam yetersizse:** Seçenek 2. Görünümlerin tanımı ASEDEN yöneticisiyle birlikte yazılır ve ASEDEN'in kendi değişiklik süreciyle uygulanır.
- **Bu süreçte:** Seçenek 5 ile Faz 2 geliştirmesi ASEDEN'e hiç dokunmadan başlayabilir.

## 4. Proje Sahibinden Beklenenler

1. ASEDEN kaynak kodunun bu oturuma **salt okuma** yetkisiyle eklenmesi (Adım A). Bu en hızlı ve en güvenli adımdır.
2. Adım B, C ve D'yi kimin uygulayacağının belirlenmesi (ASEDEN yöneticisi).
3. Keşif rolünün oluşturulmasına onay verilip verilmeyeceği (Adım D).

## 5. Bulgu Tablosu (keşif yapıldıkça doldurulacak)

| # | Bulgu | Kanıt | Tarih | Doğrulayan |
|---|---|---|---|---|
| B1 | Veritabanı motoru ve sürümü | — | — | — |
| B2 | Firestore son 30 gün okuma/yazma | — | — | — |
| B3 | Çift yazma var mı? | — | — | — |
| B4 | Uygulamanın aktif DB bağlantı hedefleri | — | — | — |
| B5 | Mevcut API var mı, kapsamı | — | — | — |
| B6 | İlgili tablo ve görünümler (satınalma, teklif, sipariş, tedarikçi, stok, AS9100) | — | — | — |
| B7 | ASEDEN'in barındırma yeri ve ajanın ağdan erişimi | — | — | — |
| B8 | Seçilen entegrasyon yöntemi (§3) | — | — | — |
