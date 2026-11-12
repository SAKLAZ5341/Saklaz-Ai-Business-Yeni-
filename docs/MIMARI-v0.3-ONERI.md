# Mimari Güncelleme Önerisi v0.3 — Çok Cihazlı, Her Yerden Erişilebilir Platform

> **Tarih:** 2026-11-12
> **Durum:** Öneri. **Kod değişikliği yapılmadı.** Proje sahibinin onayını bekliyor.
> **Temel:** ARCHITECTURE.md v0.2, SECURITY.md v0.2, FAZ1-PLAN.md, Sprint 1 kodu

## 0. Özet

**Ürün kararı:** SAKLAZ AI; telefondan, dünyanın her yerinden, birden fazla bilgisayara ve yetki verilen sistemlere güvenli erişim sağlayan bir platform olacak. Kişisel ve kurumsal alanlar birbirinden tamamen ayrı tutulacak.

**Mevcut mimari bu hedefe büyük ölçüde hazır.** On dört gereksinimden onu mevcut tasarımda zaten karşılanıyor veya küçük eklemelerle karşılanıyor. Gerçek anlamda yeni olan **dört kavram** var:

| # | Yeni kavram | Neden gerekli |
|---|---|---|
| Y1 | **Çalışma alanı (workspace):** kendi kök anahtarı, cihazları, relay'i ve denetim kaydı olan bağımsız güven alanı | Kişisel ve kurumsal alanın tamamen ayrılması |
| Y2 | **İmzalı cihaz listesi (roster):** her çalışma alanında, sahip anahtarıyla imzalanmış, değiştirilemez cihaz kaydı | Birden çok telefon ve bilgisayar olduğunda, sunucu ele geçirilse bile yetkisiz cihaz eklenememesi |
| Y3 | **Kurtarma mekanizması:** yedek cihaz, kağıt kurtarma anahtarı ve zaman kilitli kurtarma | Telefon kaybolduğunda bütün bilgisayarlara erişimin kalıcı olarak kesilmemesi |
| Y4 | **Çalışma alanları arası denetimli aktarım** | Alanlar arası dosya aktarımının ayrıca yetkilendirilmesi |

**Güvenlik çekirdeği yeniden yazılmıyor.**

| Bileşen | Durum |
|---|---|
| `packages/crypto` | **Değişmiyor.** Noise_KK, mühürlü zarf, SAS ve imzalar olduğu gibi kullanılacak. |
| `packages/protocol` | Yalnızca **eklemeler** yapılacak: başlığa iki alan, yeni mesaj tipleri ve iki yeni imza alanı. Mevcut testler korunacak, test vektörleri yeniden üretilecek. |

**Süre etkisi:** Önerilen kapsamla Faz 1 yaklaşık **10 haftadan 13 haftaya** uzar (§6). Sprint 2 yaklaşık 1 hafta büyür.

## 1. Gereksinimlerin Mevcut Durumla Karşılaştırması

| # | Gereksinim | Mevcut tasarımda | Yapılması gereken |
|---|---|---|---|
| 1 | İnternet üzerinden güvenli bağlantı | ✅ TLS 1.3 üzerinde WSS; ajan yalnızca giden bağlantı kurar | Kişisel alan için ikinci bir relay (§2.1) |
| 2 | Uçtan uca şifreleme | ✅ Noise_KK (resmî test vektörüyle doğrulandı), çevrimdışı alıcı için mühürlü zarf | Değişiklik yok |
| 3 | Her cihazın bağımsız kimliği ve anahtarı | ✅ Her telefon ve bilgisayarın kendi Ed25519 ve X25519 anahtarları var | Anahtarlar **çalışma alanı başına** ayrı üretilir (§2.1) |
| 4 | Her komutun telefonda imzalanması | ✅ Sprint 1'de uygulandı ve testli | İmzalı başlığa çalışma alanı kimliği eklenir |
| 5 | Sunucu yalnızca şifreli mesaj aktarır | ✅ Kör aktarıcı modeli (ADR-0001) | Değişiklik yok |
| 6 | Dosyalar varsayılan olarak yerelde işlenir | ✅ Tüm araçlar ajanda; dış AI varsayılan kapalı | Değişiklik yok |
| 7 | Kişisel ve kurumsal alan izolasyonu | ❌ Yok | **Y1 Çalışma alanı modeli** + **Y4 denetimli aktarım** |
| 8 | Her cihazın ayrı yetkileri | 🟨 Telefon rolleri ve bilgisayar başına yetenek izinleri var | Roller cihaz listesinde imzalı tutulur (Y2) |
| 9 | İki aşamalı kimlik doğrulama | ✅ Relay girişi: parola + TOTP. Komutlar: cihaz anahtarı + biyometri | Değişiklik yok (katmanlar §2.6'da) |
| 10 | Cihaz iptali ve acil erişim kesme | 🟨 Tasarlandı; protokolde var, ajan tarafı Sprint 2'de | İptal, imzalı cihaz listesine taşınır (Y2) |
| 11 | Güvenli yedekleme ve kurtarma | 🟨 Yalnızca yerel şifreli yedek planlıydı. **Telefon kaybında uzaktan kurtarma yoktu.** | **Y3 Kurtarma mekanizması** |
| 12 | İşlem geçmişi ve denetlenebilir kayıt | 🟨 Hash zincirli denetim kaydı Sprint 2'de | Kayıtlar çalışma alanı başına ayrı tutulur |
| 13 | Ağ kesintisinde güvenli görev yönetimi | ✅ Kuyruk, imzalı ömür, kayan pencere, kesintide yazma işlemlerinin otomatik tekrarlanmaması | Yedekten geri yüklemede tekrar oynatma koruması (§2.5.4) |
| 14 | Güvenli otomatik güncelleme ve yazılım imzalama | 🟨 Tasarlandı: Authenticode + çevrimdışı Ed25519 manifest | Sürüm geri alma koruması ve kademeli dağıtım (§2.7) |

## 2. Mimari Eklemeler

### 2.1 Y1 — Çalışma Alanları

Çalışma alanı bir **güven alanıdır.** Kendi kök kimliği, cihaz listesi, relay'i, politikaları ve denetim kaydı vardır. İki alan arasında **hiçbir anahtar, kayıt veya bağlantı paylaşılmaz.**

```
                     ┌──────────────────────── TELEFON ────────────────────────┐
                     │   KİŞİSEL alan anahtarları    │  KURUMSAL alan anahtarları │
                     │   (komut + onay, Keystore)    │  (komut + onay, Keystore;  │
                     │                               │   tercihen Android Work    │
                     │                               │   Profile içinde)          │
                     └──────────┬────────────────────┴──────────┬────────────────┘
                                │ E2EE                          │ E2EE
                   ┌────────────▼───────────┐       ┌───────────▼────────────┐
                   │ Kişisel relay          │       │ Kurumsal relay         │
                   │ (kendi VPS'iniz veya   │       │ (şirket DMZ VM, 443)   │
                   │  ev sunucusu)          │       │                        │
                   └────────────┬───────────┘       └───────────┬────────────┘
                                │                               │
                   ┌────────────▼───────────┐       ┌───────────▼────────────┐
                   │ Ev bilgisayarı ajanı   │       │ Şirket bilgisayarı     │
                   │ + ileride diğer kişisel│       │ ajanı + ileride diğer  │
                   │   bilgisayarlar        │       │ kurumsal bilgisayarlar │
                   └────────────────────────┘       └────────────────────────┘
          Kişisel cihaz listesi + denetim kaydı    Kurumsal cihaz listesi + denetim kaydı
```

#### Kurallar

| Kural | Açıklama |
|---|---|
| **Ayrı relay** | Kişisel trafik şirket sunucusundan geçmez; kurumsal trafik kişisel sunucudan geçmez. Böylece şirket BT'si, kişisel kullanımınızın meta verisini (ne zaman, hangi cihaz) bile göremez. |
| **Ayrı anahtar setleri** | Telefon her alan için ayrı komut ve onay anahtarları üretir. Bir alandaki imza diğer alanda geçersizdir: imzalı başlığa `ws` (çalışma alanı kimliği) eklenir ve onay özeti de bunu kapsar. |
| **Bir bilgisayar, bir alan** | Her ajan kurulumu tek bir alana aittir. Aynı bilgisayar iki alanda kullanılacaksa **iki ayrı Windows kullanıcı hesabında iki ayrı ajan** kurulur. Dosya izinleri işletim sistemi düzeyinde de ayrılmış olur. |
| **Android Work Profile (önerilen)** | Şirketin mobil cihaz yönetimi (MDM) varsa, kurumsal alan telefonda Work Profile içinde **ayrı bir uygulama örneği** olarak çalışır. Android, iki profilin verisini ve anahtarlarını işletim sistemi düzeyinde ayırır. MDM yoksa tek uygulama içinde ayrı anahtar setleri kullanılır; bu daha zayıf ama yine şifreli bir ayrımdır. |
| **Görsel ayrım** | Telefon arayüzünde her alanın sabit rengi ve adı olur. Onay ekranı, işlemin **hangi alanda** yapılacağını büyük harflerle gösterir. Yanlış alana komut gönderme riski bu şekilde azaltılır. |
| **Kurumsal alanın sahipliği** | Kurumsal alanın kök sahibi başlangıçta siz olursunuz. İleride şirket BT'sinin de sahip veya denetçi olması gerekirse, bu kurumsal cihaz listesine imzalı bir girişle eklenir. Kişisel alanınız bundan hiçbir şekilde etkilenmez. |

### 2.2 Y2 — İmzalı Cihaz Listesi (Roster)

**Sorun:** Bugünkü tasarımda her telefon her bilgisayarla tek tek eşleşiyor. Bu tek telefon için yeterli. Ancak birden çok telefon ve bilgisayar olduğunda, "bu alanda kim yetkili?" sorusunun cevabı tek bir yerde ve sunucudan bağımsız olarak tutulmalıdır.

**Çözüm:** Her çalışma alanında, **sahip onay anahtarlarıyla imzalanmış, sadece ekleme yapılabilen, hash zincirli** bir cihaz listesi tutulur.

```
Giriş 0 (başlangıç): alan kimliği, ilk sahip telefonun onay anahtarı, kurtarma anahtarının açık anahtarı
Giriş 1: ekle  { cihaz: ev-pc,     tür: bilgisayar, yetenekler: [...] }  imza: sahip
Giriş 2: ekle  { cihaz: telefon-2, tür: telefon,    rol: operator }      imza: sahip
Giriş 3: iptal { cihaz: telefon-2, neden: "kayboldu" }                    imza: sahip
...      her giriş: önceki girişin özeti + sıra no + SAKLAZ-v1/roster alanında imza
```

| Konu | Davranış |
|---|---|
| **Kim değiştirebilir** | Yalnızca sahip rolündeki cihazların **onay anahtarı** (biyometrik) veya kurtarma anahtarı (§2.5). Sunucunun anahtarı yoktur, giriş üretemez. |
| **Yeni bilgisayar ekleme** | Bilgisayar ekranında QR gösterilir, telefon okur ve SAS eşleşir (mevcut eşleştirme protokolü). Ardından telefon, listeye imzalı bir "ekle" girişi yazar. **Fiziksel varlık ve sahip imzası birlikte gerekir.** |
| **Yeni telefon ekleme** | Yeni telefon, alandaki herhangi bir bilgisayarın ekranındaki QR'ı okur (fiziksel varlık). Mevcut bir sahip telefon bu ekleme işlemini imzalar. |
| **Dağıtım** | Liste relay üzerinden şifreli olarak dağıtılır. Her cihaz zinciri ilk girişten itibaren doğrular. Sunucu listeyi saklar ama **sahte giriş ekleyemez ve sıralamayı değiştiremez.** |
| **Güncel olmayan listeyi tespit** | Her imzalı mesajın başlığına gönderenin bildiği liste sürümü (`rh`) eklenir. Alıcının listesi daha eskiyse, mesaj işlenmeden önce eksik girişler çekilir. Böylece sunucu bir iptali gizleyip eski listeyi gösteremez; ancak gecikme riski vardır (§3.2). |
| **Çatallanma** | Aynı sıra numarasıyla iki farklı giriş görülürse, liste değişiklikleri durdurulur ve kullanıcı uyarılır. Bu durum ya iki sahip cihazın eşzamanlı işlem yaptığını ya da bir saldırıyı gösterir. Çözüm sahibin kararıdır. |

**Mevcut tasarımla ilişki:** Bu yapı, Sprint 1'deki eşleştirme ve SAS kodunu **kullanır**; yerine geçmez. Eşleştirme "bu cihaz gerçekten karşımdaki cihaz mı" sorusunu yanıtlar, liste ise "bu alanda kim yetkili" sorusunu.

### 2.3 Çoklu Bilgisayar ve Yetkili Sistemler

- **Bilgisayar seçimi:** Telefon, alan içindeki her bilgisayarı ayrı ayrı görür: çevrimiçi durumu, son görülme zamanı ve kuyruktaki görevler. Komut tek bir bilgisayara gönderilir. "Tüm bilgisayarlara" komutu bilinçli olarak **yoktur**; toplu işlem riski yaratır. Faz 2'de ayrıca değerlendirilebilir.
- **Bilgisayar başına yetki:** Her bilgisayarın yetenekleri (dosya, uygulama, tarayıcı, ERP, e-posta) **o bilgisayarda yerel olarak** açılır ve listeye bilgi amaçlı yazılır. Telefon bir bilgisayara o bilgisayarda kapalı olan bir yetenek için komut veremez. Ajan yine de her zaman kendi yerel politikasını uygular.
- **"Yetki verdiğim uygulamalar ve sistemler":** Mevcut yetenek modeli (FAZ1-PLAN §7) ile karşılanır. Her yeni sistem; risk seviyesi tanımlı, varsayılan kapalı ve yerel olarak açılan bir araç olarak eklenir. ERP bu yapının ilk örneğidir.

### 2.4 Y4 — Çalışma Alanları Arası Denetimli Aktarım

**Varsayılan davranış:** Alanlar arası aktarım **imkânsızdır.** Bu özellik yapılana kadar iki alan arasında veri akışı için teknik bir yol yoktur; bu da en güvenli başlangıç durumudur.

Özellik eklendiğinde aktarım şu şekilde işler:

```
Kurumsal bilgisayar ──(E2EE, kurumsal alan)──► TELEFON ──(E2EE, kişisel alan)──► Ev bilgisayarı
         ▲                                        │                                    ▲
   1. Kaynak alanda kritik onay              Dosya yalnızca bellekte,           2. Hedef alanda kritik onay
      (kurumsal onay anahtarı)               aktarım boyunca bulunur;           (kişisel onay anahtarı)
   Kurumsal politika aktarımı                diske yazılmaz
   yasaklıyorsa ajan reddeder
```

| Kural | Neden |
|---|---|
| **Çift onay:** hem kaynak alanda hem hedef alanda, ayrı onay anahtarlarıyla | Tek bir onay iki alanı birden açamaz |
| **Kaynak alan politikası üstündür** | Şirket "dışarı aktarım yok" politikası koyarsa, kurumsal ajan aktarımı başlatmaz. Bu, şirketin veri kaybı önleme (DLP) ihtiyacına uyar. |
| Aktarım **yalnızca telefon üzerinden** yapılır; bilgisayarlar birbirine doğrudan bağlanmaz | Alanlar arasında anahtar veya güven paylaşımı oluşmaz |
| Her iki alanın denetim kaydına da işlenir | Dosya adı, boyut, özet, onaylayan cihaz ve zaman kayda geçer |
| Boyut sınırı (öneri: 50 MB) | Telefon belleği ve aktarım süresi |

**Öneri:** Bu özellik **Faz 2'de** yapılsın. Faz 1'de aktarımın tamamen kapalı olması güvenlik açısından daha iyidir.

### 2.5 Y3 — Yedekleme ve Kurtarma

#### 2.5.1 Neden gerekli

Bugünkü tasarımda tek telefon kaybolursa, her bilgisayara fiziksel olarak gidip yeniden eşleştirme yapmak gerekiyor. Yurtdışındayken ve birden çok bilgisayar varken bu kabul edilemez. Öte yandan, kötü tasarlanmış bir kurtarma mekanizması **sunucunun veya bir saldırganın kullanabileceği bir arka kapı** olur. Aşağıdaki üç katman bu dengeyi kurar.

#### 2.5.2 Kurtarma katmanları

| Katman | Nasıl | Ne zaman kullanılır |
|---|---|---|
| **1. Yedek cihaz (önerilen)** | İkinci bir telefon veya tablet, alanda **sahip** olarak kayıtlıdır | Ana telefon kaybolursa: yedek cihaz kayıp telefonu hemen iptal eder ve yeni telefonu ekler. Bekleme süresi yoktur. |
| **2. Kağıt kurtarma anahtarı** | Alan oluşturulurken 24 kelimelik bir kurtarma ifadesi üretilir. Bu ifadeden bir Ed25519 anahtarı türetilir ve açık anahtarı cihaz listesinin ilk girişine yazılır. İfade **yalnızca kağıda** yazılır; dijital ortamda saklanmaz. | Hiçbir sahip cihaz kalmadıysa |
| **3. Fiziksel erişim** | Bilgisayarın başında, Windows Hello ile yerel yeniden eşleştirme | Her zaman çalışan son çare |

#### 2.5.3 Zaman kilitli kurtarma (kağıt anahtar kullanılırken)

1. Yeni telefona kurtarma ifadesi girilir. Telefon, "yeni sahip ekle" isteğini kurtarma anahtarıyla imzalar.
2. İstek alandaki **her bilgisayara** ve kalan sahip cihazlara bildirilir. **72 saatlik bekleme** başlar. Bilgisayar ekranlarında da uyarı gösterilir.
3. Bu süre içinde herhangi bir sahip cihaz veya bilgisayarın başındaki kullanıcı (Windows Hello ile) isteği **veto edebilir.**
4. Veto gelmezse istek uygulanır; eski sahip cihazlar iptal edilir.

**Neden bekleme süresi:** Kurtarma kağıdı çalınırsa, saldırgan hemen kontrolü ele geçiremez. Sizin fark edip veto etmeniz için zaman kalır.

**Kalan risk:** Hem kurtarma kağıdı çalınırsa hem sunucu ele geçirilip veto mesajlarınızı engellerse, saldırgan 72 saat sonra sahip olabilir. Bu senaryoya karşı **bilgisayardaki yerel veto** sunucudan bağımsız çalışır: bilgisayar uyarıyı ekranında gösterir, veto yerelde verilir.

#### 2.5.4 Veri yedekleme

| Veri | Yedekleme |
|---|---|
| Ajan veritabanı (görev geçmişi, denetim kaydı, izinler) | Şifreli yedek. Anahtar kurtarma ifadesinden türetilir. Yedek kullanıcının seçtiği yerel konuma veya **şifreli olarak relay'e** yazılabilir; sunucu içeriğini okuyamaz. |
| Cihaz listesi | Her cihazda tam kopya bulunur ve kendiliğinden yedeklidir. |
| Cihaz kimlik anahtarları | **Yedeklenmez.** Kurtarma yeni anahtarla ve yeni bir liste girişiyle yapılır. |
| Kişisel dosyalarınız | SAKLAZ'ın kapsamı dışındadır (mevcut yedekleme düzeniniz). |

**Geri yüklemede tekrar oynatma koruması (yeni bulgu):** Eski bir yedek geri yüklenirse, ajanın sayaç durumu da eski haline döner. Bu durumda, yedekten sonra işlenmiş ama ömrü henüz dolmamış (en çok 72 saat) mesajlar **tekrar çalıştırılabilir.**

Önlem: Geri yükleme sonrasında ajan, zaman damgası **geri yükleme anından önce** olan tüm mesajları reddeder. Ayrıca ilk iş olarak cihaz listesini telefonlardan yeniden senkronize eder.

### 2.6 Kimlik Doğrulama Katmanları

| Katman | Ne korur | Sunucu ele geçirilirse |
|---|---|---|
| Relay hesabı: parola (Argon2id) + **TOTP** | Relay'e bağlanmayı | Etkisiz kalır; zaten **komut yetkisi vermez** |
| Cihaz anahtarı (Keystore / DPAPI) | Kim olduğunuzu kriptografik olarak | Etkilenmez |
| Biyometrik doğrulama (her onayda) | Telefon kilidi açık olsa bile kritik işlemleri | Etkilenmez |
| Uygulama kilidi (biyometri veya PIN, uygulama açılırken) | Telefon başkasının elindeyken komut gönderilmesini | Etkilenmez |

Sonuç olarak gerçek iki aşamalı doğrulama, **"sahip olunan cihaz anahtarı + biyometri"** ikilisidir. Relay girişindeki TOTP ise ek bir katmandır.

### 2.7 Güncelleme ve Yazılım İmzalama

Mevcut tasarımda Authenticode + çevrimdışı Ed25519 manifest vardı (KOD-IMZALAMA-ONERI.md). Eklenenler:

| Ekleme | Neden |
|---|---|
| **Sürüm geri alma koruması:** ajan yalnızca daha yüksek sürüm numaralı manifesti kabul eder | Saldırganın bilinen açığı olan eski bir sürümü "güncelleme" diye yüklemesini engeller |
| **Kademeli dağıtım:** önce tek bilgisayar, sorun yoksa diğerleri | Hatalı bir sürüm bütün bilgisayarları aynı anda bozmaz |
| **Güncelleme kanalı relay'den ayrıdır** | Relay ele geçirilse bile güncelleme dağıtamaz |
| **Kullanıcı güncellemeyi telefondan erteleyebilir** | Kritik bir iş sırasında yeniden başlatma olmaz |
| **Faz 4: yayın imzası için iki kişi onayı (2'den 2 imza)** | Tek bir yayın anahtarının ele geçirilmesi yetmez |

### 2.8 Performans

| İhtiyaç | Çözüm | Hedef (ölçülecek) |
|---|---|---|
| Hızlı bağlantı | Sürekli açık WSS bağlantısı, ön belleğe alınmış Noise oturumu (her komutta yeni el sıkışma yapılmaz), küçük mesajlar | Telefon ile bilgisayar çevrimiçiyken komutun bilgisayara ulaşması p95 < 1 sn |
| Çevrimdışı kuyruk | Mevcut: imzalı ömür 72 saate kadar, mühürlü zarf | — |
| Cihaz durumu | Relay'den çevrimiçi durumu, alan başına | Durum değişikliğinin telefona yansıması < 5 sn |
| Anlık bildirim | İçeriksiz FCM uyandırma sinyali (karar D3), alan başına ayrı Firebase projesi | — |

**Doğrudan bağlantı (P2P):** Telefonun bilgisayara relay olmadan, doğrudan bağlanması gecikmeyi azaltabilir. Ancak NAT delme işlemi saldırı yüzeyini ve karmaşıklığı artırır, ayrıca evde veya şirkette gelen bağlantı gerektirebilir. **Faz 1'de önerilmiyor.** Relay yeterince hızlı değilse Faz 3'te ölçüme dayanarak değerlendirilir.

## 3. Güvenlik Değerlendirmesi

### 3.1 Sunucu ele geçirilirse — istediğiniz beş garanti

| Garanti | Sağlanıyor mu? | Mekanizma | Durum |
|---|---|---|---|
| **Dosyalar okunamamalı** | ✅ | Uçtan uca şifreleme; anahtarlar yalnızca cihazlarda. Relay yalnızca şifreli metin görür. | Noise_KK Sprint 1'de doğrulandı |
| **Komut üretilememeli** | ✅ | Her komut telefon anahtarıyla imzalı; sunucunun anahtarı yok | Sprint 1'de testli (sahte imza, sahte gönderen) |
| **Eski komutlar tekrar çalıştırılamamalı** | ✅ | Kayan pencereli sayaç, imzalı ömür, tek kullanımlık onay. Geri yükleme koruması (§2.5.4) eklenecek. | Sprint 1'de testli; geri yükleme kısmı yeni |
| **Yetkisiz cihaz eklenememeli** | ✅ | Eklemek için fiziksel QR + SAS **ve** sahip imzalı liste girişi gerekir. Sunucu ikisini de üretemez. | Eşleştirme kriptografisi Sprint 1'de; liste yeni (Y2) |
| **Kritik işlemler gerçekleştirilememeli** | ✅ | İşleme bağlı, biyometrik, ayrı onay anahtarıyla imzalı onay | Sprint 1'de testli |

### 3.2 Sunucu ele geçirilirse — dürüst kalan riskler

| Saldırganın yapabileceği | Etki | Önlem |
|---|---|---|
| Hizmeti durdurmak | Uzaktan erişim kesilir. Bilgisayarlar yerelde çalışmaya devam eder. | Kabul edilir. Yedek relay kurmak Faz 3'te değerlendirilebilir. |
| Meta veriyi görmek (hangi cihaz, ne zaman, ne boyutta) | Kullanım alışkanlıkları ortaya çıkar; içerik çıkmaz | Ayrı relay'ler sayesinde kişisel ve kurumsal meta veri birbirine karışmaz. Faz 3'te dolgu ve sabit boyutlu mesajlar değerlendirilebilir. |
| **Mesajları geciktirmek veya düşürmek; bir iptal mesajını iletmemek** | Kayıp bir telefonun iptali bilgisayara geç ulaşabilir | **Önlemler:** (a) yerel iptal ve yerel acil kilit sunucudan bağımsız çalışır; (b) her imzalı mesajın başlığındaki liste sürümü sayesinde, bilgisayar bir sonraki meşru mesajda eksikliği fark eder; (c) iptal, diğer tüm cihazlardan da yayılır. |
| Sahte cihaz açık anahtarı yayınlamak | Etkisiz: cihazlar listeyi kendileri doğrular | — |

**Çift ihlal senaryosu:** Bu senaryoda sunucu ele geçirilmiş, **aynı anda** telefonunuz çalınmış ve biyometri aşılmış olmalı; ayrıca sunucu iptal mesajlarınızı engelliyor olmalı. Bu durumda saldırgan, siz yerel iptal yapana kadar o telefonla işlem yapabilir.

Bu, **iki bağımsız ihlal** gerektirir. Çözüm, bilgisayarın başında veya ikinci bir sahip cihazdan yerel acil kilittir; ayrıca uzaktan acil kilit de imzalı olarak kuyruğa alınır. Bu riskin tamamen ortadan kaldırılamayacağını açıkça belirtiyorum.

### 3.3 Diğer cihazların ele geçirilmesi

| Senaryo | Etki alanı | Sınırlayan |
|---|---|---|
| Ev bilgisayarı ele geçirildi | Yalnızca **kişisel** alan ve yalnızca o bilgisayarın yetkileri | Alan izolasyonu; o bilgisayar, telefon imzası olmadan diğer bilgisayarlara komut veremez |
| Telefonun işletim sistemi tamamen ele geçirildi (root ve kötü amaçlı yazılım) | **Her iki alan** risk altında; telefon iki alan arasındaki tek ortak noktadır | Work Profile, StrongBox (anahtarlar dışarı çıkarılamaz), her onayda biyometri, Play Integrity. Kurumsal alanı ayrı bir telefonda tutmak, şirket politikasıyla zorunlu kılınabilir. |
| Kurtarma kağıdı çalındı | Saldırgan sahip olmaya çalışabilir | 72 saatlik zaman kilidi ve yerel veto |
| Yayın (güncelleme) anahtarı çalındı | **En kritik senaryo:** kötü amaçlı güncelleme dağıtılabilir | Anahtar çevrimdışı ortamda; Authenticode ile çift imza; Faz 4'te 2'den 2 imza |

## 4. Sprint 1 Koduna Etkisi

Güvenlik çekirdeği yeniden yazılmıyor. Gerekenler yalnızca **eklemeler**:

| Paket | Değişiklik | Tahmini iş |
|---|---|---|
| `packages/crypto` | **Yok.** Kurtarma anahtarı türetimi için küçük bir yardımcı (ifade → Ed25519 tohumu) eklenecek. | 0,5 gün |
| `packages/protocol` başlık | `ws` (çalışma alanı kimliği) ve `rh` (liste sürümü) alanları eklenecek. İmzalı içeriğe dahil oldukları için vektörler yeniden üretilecek. | 0,5 gün |
| `packages/protocol` imza alanları | `SAKLAZ-v1/roster` ve `SAKLAZ-v1/recovery` eklenecek | 0,5 gün |
| `packages/protocol` yeni modül | `roster.ts`: liste girişleri, zincir doğrulama, çatallanma tespiti | 2 gün (testlerle birlikte) |
| `packages/protocol` onay özeti | Özet `ws` alanını da kapsayacak | Yukarıdakine dahil |
| Testler | Mevcut 82 testin tamamı korunacak. Liste ve alan izolasyonu testleri eklenecek. | — |

**Protokol sürümü:** Henüz hiçbir şey kullanıma çıkmadığı için `saklaz/1` korunabilir. Değişiklikler, ilk sürüm öncesinde yapılan bir şema güncellemesi olarak ele alınır.

## 5. Sprint 2'ye Etkisi

| Sprint 2 planı (önceki) | Değişiklik |
|---|---|
| Relay: hesap, MFA, cihaz kaydı, WSS, kuyruk, çevrimiçi durumu | **Çalışma alanı kavramı** eklenir. Relay yazılımı tek alana hizmet edecek şekilde sadeleşir (her alanın kendi relay örneği olur). Net etki küçük. |
| Ajan: transport, doğrulayıcı, SQLite, denetim kaydı | Kayıtlar alan kimliğiyle etiketlenir. **Geri yükleme koruması** eklenir. |
| Eşleştirme (QR + SAS) | Eşleştirme sonunda **imzalı cihaz listesine giriş** yazılır |
| Acil kilit ve iptal | İptal **cihaz listesi girişi** olarak yapılır |
| Dart kütüphane kararı | Değişiklik yok |
| **Yeni:** Protokol eklemeleri ve `roster.ts` | +3,5 gün |
| **Yeni:** Liste senkronizasyonu (`rh` uyuşmazlığında eksik girişlerin çekilmesi) | +2 gün |

**Sprint 2 süresi: 2 haftadan yaklaşık 3 haftaya çıkar.**

## 6. Geliştirme Süresi

| İş | Sprint | Ek süre |
|---|---|---|
| Protokol eklemeleri + cihaz listesi + senkronizasyon | S2 | +1 hafta |
| Telefonda çoklu alan: ayrı anahtar setleri, alan seçimi, renk ve isim ayrımı, Work Profile desteği | S4 | +1 hafta |
| Kurtarma: yedek cihaz akışı, kurtarma ifadesi, 72 saatlik zaman kilidi ve veto, şifreli veri yedeği | **Yeni S6** | +1 hafta |
| Kişisel relay'in kurulumu (aynı yazılım, ikinci örnek) | S5 | +1–2 gün (S5 içinde) |
| Alanlar arası aktarım (Y4) | **Faz 2 (önerilen)** | 0 (Faz 1'de) |

### Seçenekler

| Seçenek | Faz 1 kapsamı | Toplam süre |
|---|---|---|
| **A (önerilen)** | Çalışma alanları + cihaz listesi + kurtarma. Alanlar arası aktarım kapalı; Faz 2'de eklenecek. | **≈ 13 hafta** (önceki 10) |
| B | A + alanlar arası aktarım | ≈ 14 hafta |
| C | Yalnızca çalışma alanları + cihaz listesi; kurtarma Faz 2'de | ≈ 12 hafta. **Önermiyorum:** her yerden erişimin olduğu bir sistemde telefon kaybı tüm erişimi keser. |

**A seçeneğini öneriyorum.** Kurtarma mekanizması günlük kullanıma geçmeden önce olmalıdır. Alanlar arası aktarım ise yokken daha güvenlidir.

## 7. Teknik Riskler

| # | Risk | Olasılık | Etki | Önlem |
|---|---|---|---|---|
| T1 | Cihaz listesinde çatallanma (iki sahip cihaz aynı anda değişiklik yapar) | Düşük | Orta | Çatallanma tespit edildiğinde değişiklikler durur ve kullanıcı karar verir. Özellik tabanlı testler yazılacak. |
| T2 | Sunucunun iptal mesajını geciktirmesi | Orta (sunucu ele geçirilirse) | Orta | Yerel iptal ve kilit, liste sürümü kontrolü, iptalin tüm cihazlardan yayılması (§3.2) |
| T3 | Kullanıcının yanlış alana komut göndermesi | Orta | Orta | Alan imzalı başlıkta; renk ve isim ayrımı; onay ekranında alan adı büyük harflerle |
| T4 | Telefonun iki alanın ortak noktası olması | Düşük | Yüksek | Work Profile, StrongBox, politika ile ayrı telefon seçeneği |
| T5 | Kurtarma ifadesinin kaybı ve yedek cihaz olmaması | Orta | Yüksek | Kurulumda yedek cihaz güçlü şekilde önerilir. Fiziksel erişim her zaman son çaredir. |
| T6 | Kurtarma ifadesinin çalınması | Düşük | Yüksek | 72 saatlik zaman kilidi, yerel veto, bilgisayar ekranında uyarı |
| T7 | Kişisel relay'in barındırılması (evde dinamik IP ve NAT; ya da VPS işletimi) | Orta | Orta | Önerim: sizin adınıza küçük bir VPS. Ev sunucusu da mümkün ama 443 yönlendirmesi ve dinamik DNS gerektirir. |
| T8 | Geri yüklemede tekrar oynatma | Düşük | Yüksek | §2.5.4 önlemi; özel test senaryosu yazılacak |
| T9 | Kapsam büyümesi | Orta | Orta | Alanlar arası aktarım Faz 2'ye ertelendi; P2P ertelendi |
| T10 | Kurumsal BT'nin kişisel alana erişim talebi | Düşük | Yüksek | Ayrı relay, ayrı anahtar ve ayrı kurulum: teknik olarak erişim imkânsızdır |

## 8. Kararınız Gereken Konular

| # | Konu | Seçenekler | Önerim |
|---|---|---|---|
| 1 | **Kapsam ve süre** | A / B / C (§6) | **A** (≈ 13 hafta) |
| 2 | **Kişisel relay'in yeri** | Sizin adınıza VPS · Ev sunucusu · Şimdilik yalnızca kurumsal alan | **VPS** (yurt içi veya AB, sizin seçiminiz). Aylık maliyeti düşük; teklif aşamasında netleşir. |
| 3 | **Telefonda kurumsal alan** | Work Profile (şirkette MDM varsa) · Aynı uygulamada ayrı anahtar setleri · Ayrı telefon | Şirkette MDM varsa **Work Profile**, yoksa ayrı anahtar setleri |
| 4 | **Yedek cihaz** | Var / Yok | **Var**: ikinci bir telefon veya tablet sahip olarak kayıtlı olsun |
| 5 | **Kurtarma zaman kilidi** | 24 / 72 / 168 saat | **72 saat** |
| 6 | **Kurumsal alanın sahibi** | Yalnızca siz · Siz + şirket BT'si | Başlangıçta yalnızca siz; ileride listeye imzalı girişle eklenebilir |
| 7 | Bu belgedeki mimari değişikliklerin ARCHITECTURE.md ve SECURITY.md'ye işlenmesi | Onay / düzeltme | Onayınızdan sonra işlerim (ADR-0013 Çalışma alanları, ADR-0014 İmzalı cihaz listesi, ADR-0015 Kurtarma) |

**Onayınızdan sonraki adımlar:** Belgeleri güncelleyeceğim ve Sprint 2'ye yeni kapsamla başlayacağım. Sprint 2, yine sonunda raporla bitecek ve Sprint 3 için ayrıca onayınızı bekleyecek.
