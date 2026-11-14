# Sprint 3 / A3 — Kasa v2 ve DPAPI: Test Planı

> **Tarih:** 2026-11-14
> **Durum:** Tam A3 test planı; ilk DPAPI/KEK dilimi PR #12'de uygulanmış ve henüz main'e birleştirilmemiştir. Bu nedenle tüm A3 testleri tamamlanmış sayılmaz.
> **Bağlı belge:** SPRINT-3-A3-TEKNIK-TASARIM.md

## 0.1 Uygulama ve doğrulama durumu (2026-11-14)

- PR #12 açık ve birleştirilmemiştir. Windows CI'da gerçek DPAPI modülü derlenmiş; koruma/çözme testleri ve ikinci kullanıcıyla ham DPAPI blob testi çalışmıştır. PR #12'nin sekiz zorunlu kontrolü başarılıdır.
- Mevcut ikinci kullanıcı betiği T-A3-22'nin yalnızca ham blob bölümünü kapsar. B kullanıcı Administrators grubuna eklenmektedir, görev `/rl highest` ile çalıştırılmaktadır ve parola `net user` / `schtasks /rp` süreç argümanlarına aktarılmaktadır. Bu yöntem standart kullanıcı ve kimlik bilgisi güvenliği kabul kriterlerini karşılamaz.
- Betik gerçek `ProtectedKeyStore` (`kek.bin`) dosyasını açmayı denememektedir. `ProtectedKeyStore.load()` önce SID/MachineGuid bağlama özetini karşılaştırdığı için farklı kullanıcıda kasa dosyası testi için beklenen hata `BINDING_MISMATCH`; ham DPAPI blob testi için beklenen hata `UNPROTECT_FAILED` olmalıdır.
- Bu nedenle T-A3-22'nin ham blob ve gerçek kasa dosyası alt testleri ayrı çalıştırılmalı; B standart kullanıcı olmalı ve parola hiçbir süreç komut satırına yazılmamalıdır. Tam kasa v2, atomik yazım, geçiş ve kilit kurtarma senaryoları henüz tamamlanmış kabul edilmez.

## 1. İlkeler

- Mevcut hiçbir test silinmez, atlanmaz veya gevşetilmez; kapsama eşikleri düşürülmez. `main`'de şu an Linux'ta 205, Windows'ta 148 test, Docker'da 13 test, Dart'ta 7 test ve Pester'da 8 test var.
- Kasa mantığı (dosya biçimi, AAD, atomik yazım, hata kodları) **Linux'ta da** test edilir. Bunun için yalnızca testte kullanılan bir `FakeProtector` vardır; böylece kapsama ölçümü eksik kalmaz.
- Gerçek DPAPI ve yerel modül testleri yalnızca Windows'ta koşar. Windows CI'da bu testlerin **gerçekten koştuğu doğrulanır**: win32'de yerel modül yüklenemiyorsa test kırmızı olur, sessizce atlanmaz.
- Her negatif test, hata kodunu ve **gizli değerin hiçbir çıktıda bulunmadığını** birlikte doğrular.
- Her yeni koruma için bir **negatif kontrol** yapılır: koruma geçici olarak kaldırıldığında ilgili test kırmızı olmalıdır.

## 2. Test ortamları

| Ortam | Ne koşar |
|---|---|
| Linux CI (ubuntu-24.04) | Biçim, AAD, atomik yazım, hata kodları ve geçiş testleri (`FakeProtector` ile); bütün mevcut testler |
| Windows CI (windows-2022) | Yerel modülün derlenmesi; gerçek DPAPI; ikinci yerel kullanıcıyla izolasyon; yeniden başlatma; çökme enjeksiyonu; başarım ölçümü; bütün mevcut Windows testleri |
| Gerçek Windows bilgisayar | §5 (proje sahibi veya BT yürütür) |

## 3. Test senaryoları

### 3.1 Dosya biçimi ve şifreleme (Linux + Windows)

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-01 | Oluşturma → yazma → kapatma → açma → okuma | Bütün değerler bayt bayt aynı |
| T-A3-02 | Dört gerçek ad (`db-key`, `agent-sign-seed`, `agent-dh-secret`, `state-epoch`) ile `AgentCore` uçtan uca | Mevcut ajan testleri yeni kasayla da geçer |
| T-A3-03 | **Diskte düz metin yok:** dosyanın baytları içinde KEK, her değer, değerlerin hex/base64 hali ve adlar aranır | Hiçbiri bulunmaz (adlar da şifreli) |
| T-A3-04 | Her yazımda nonce farklı, `generation` +1 | Doğrulanır |
| T-A3-05 | Ad kuralları: geçersiz karakter, 64'ten uzun ad, 64 KiB'tan büyük değer, 1 MiB'ı aşan dosya | `VAULT_FORMAT` veya argüman hatası |

### 3.2 Bozuk ve değiştirilmiş kasa (Linux + Windows)

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-10 | **Her baytın** tek tek değiştirilmesi (fast-check: rastgele bayt, rastgele bit) | Her durumda `VAULT_FORMAT`, `VAULT_VERSION`, `VAULT_CORRUPT`, `UNWRAP_FAILED` veya `PROTECTOR_MISMATCH`. **Hiçbir zaman başarılı açılış ve hiçbir zaman çökme yok.** |
| T-A3-11 | Kısaltılmış dosya (her uzunluk 0..boyut−1), boş dosya, sonuna fazladan bayt | Hata; çökme yok |
| T-A3-12 | Başlık alanlarının tek tek değiştirilmesi: sürüm, koruyucu, `vaultId`, `generation`, uzunluklar | AEAD reddeder (başlık AAD'de) |
| T-A3-13 | Bozuk dosyayla açılış denemesinden sonra dosya | **Değişmemiş** (özeti aynı); silinmemiş; üzerine yazılmamış |
| T-A3-14 | Bozuk kasayla ajan başlatma | Ajan başlamaz; veritabanı açılmaz; `MemoryVault` veya `InsecureFileVault`'a **geri düşüş yok** |

### 3.3 Bağlam bağlama (Linux sahte + Windows gerçek)

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-20 | `machineGuid` farklı (sahte koruyucuyla benzetim) | `BINDING_MISMATCH` |
| T-A3-21 | `userSid` farklı (benzetim) | `BINDING_MISMATCH` |
| T-A3-22a | **Gerçek ikinci Windows kullanıcısı — ham DPAPI blob'u:** A'nın blob'unu B çözmeye çalışır | `UNPROTECT_FAILED`; B kendi blob'unu çözebilir; A kendi blob'unu çözmeye devam eder. B standart kullanıcı olmalı. |
| T-A3-22b | **Gerçek ikinci Windows kullanıcısı — ProtectedKeyStore dosyası:** A'nın `kek.bin` dosyası B tarafından `ProtectedKeyStore.load()` ile açılmaya çalışılır | Bağlama denetimi nedeniyle `BINDING_MISMATCH`; dosya değişmez ve hiçbir gizli değer çıktılanmaz. B kendi mağazasını açabilir. |
| T-A3-23 | Gerçek DPAPI: yanlış entropy ile `unprotect` | Başarısız |
| T-A3-24 | Gerçek DPAPI: blob'da tek bayt değişikliği | Başarısız |
| T-A3-25 | `userSid()` ve `machineGuid()` | Biçimleri doğru (`S-1-5-21-…`, GUID); yönetici yetkisi olmadan çalışır |

### 3.4 Atomik yazım, çökme ve yeniden başlatma

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-30 | **Başarım:** 1.000 `state-epoch` yazımı (Windows CI) | p50, p95 ve p99 süreleri rapora yazılır. Eşik: p95 ≤ 20 ms (aşılırsa tasarım §8'deki plan devreye girer; garanti zayıflatılmaz) |
| T-A3-31 | **Çökme enjeksiyonu:** yazım sırasında her adımda (tmp yazıldı / flush edildi / rename öncesi / rename sonrası) alt süreç `SIGKILL` / `TerminateProcess` ile öldürülür, sonra yeniden açılır | Kasa her zaman ya eski ya yeni geçerli halde; veri kaybı yok; artık `.tmp-*` dosyaları açılışta temizlenir |
| T-A3-32 | **Yeniden başlatma:** ajan alt süreçte açılır, eşleştirilir, mesaj işler, kapanır; yeni süreçte yeniden açılır | Aynı cihaz kimliği, aynı veritabanı anahtarı; rollback koruması "geri yükleme yok" der |
| T-A3-33 | Yeniden başlatmadan sonra rollback testi: veritabanı dosyası eski kopyayla değiştirilir | Mevcut S20 davranışı korunur: geri yükleme tespit edilir |
| T-A3-34 | Yazım hatası (salt okunur dosya, kilitli hedef) | `WRITE_FAILED`; bellekteki durum ve dosya eski halinde; ajan mesajı onaylamaz |
| T-A3-35 | Antivirüs benzetimi: hedef dosya kısa süre paylaşımsız açık tutulur | Yeniden deneme sonrası başarılı; süre sınırı aşılırsa `WRITE_FAILED` |
| T-A3-36 | İkinci süreç aynı kasayı açmaya çalışır | `VAULT_LOCKED`; canlı kilit hiçbir koşulda çalınmaz |
| T-A3-37 | **Sahip süreç kilit dosyasını oluşturduktan sonra zorla sonlandırılır; yeni süreç yeniden açar** | OS tanıtıcısı bırakılmış olsa da kalan dosya girdisi güvenli protokolle ele alınır; canlı süreç kilidi silinmez/çalınmaz; kurtarma sonucu ve hata kodu doğrulanır |

### 3.5 Yetkisiz erişim ve günlük

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-40 | Bütün hata yollarında yakalanan hata nesneleri, `message`, `stack` ve denetim kaydı satırları taranır | KEK, değerler ve blob baytları (hex/base64 dahil) **yok** |
| T-A3-41 | Ajan günlükleri ve denetim kaydı (bütün test boyunca) | Aynı tarama; bulunmaz |
| T-A3-42 | Kasa klasörünün ACL'i (`icacls`, Windows CI) | `Everyone`, `Users` veya `Authenticated Users` için okuma izni **yok** |
| T-A3-43 | Üretim fabrikası: win32 değil veya yerel modül yok | `UNSUPPORTED_PLATFORM`; güvensiz kasaya geri düşüş **yok** (negatif kontrol: geri düşüş kodu eklenirse test kırmızı) |
| T-A3-44 | Üretim fabrikası, `SAKLAZ_INSECURE_VAULT=1` ayarlı olsa bile | `InsecureFileVault` döndürmez |
| T-A3-45 | Sınır denetimi: `protectors/fake` üretim kodundan içe aktarılırsa | `check:boundaries` kırmızı (negatif test) |

### 3.6 Geçiş ve geriye dönük uyumluluk

| ID | Senaryo | Beklenen |
|---|---|---|
| T-A3-50 | Eski güvensiz kasa varken üretim açılışı | `LEGACY_VAULT_PRESENT`; hiçbir dosya değişmez |
| T-A3-51 | `vault migrate` başarılı | Yeni kasa doğrulanır (değerler aynı, veritabanı açılıyor); eski dosya `vault.json.migrated-*` olarak **yeniden adlandırılır, silinmez** |
| T-A3-52 | `vault migrate` her adımda kesilirse (çökme enjeksiyonu) | Eski dosya **hiçbir durumda** kaybolmaz veya değişmez; yarım yeni dosya temizlenir |
| T-A3-53 | `vault migrate`, `SAKLAZ_INSECURE_VAULT=1` olmadan | Reddedilir |
| T-A3-54 | `SecretVault` arayüzü | Değişmemiş (tip testi); `MemoryVault` ve `InsecureFileVault` testleri aynen geçer |
| T-A3-55 | **Bütün mevcut testler** (Linux 205, Windows 148, Docker 13, Dart 7, Pester 8) | Hepsi geçer; sayılar azalmaz |
| T-A3-56 | Protokol vektörleri ve kripto paketi | Bayt bayt değişmemiş (`git diff` boş; vektör sapma testi) |

## 4. Windows CI ayrıntıları

### 4.1 Eklenecek adımlar (workflow değişikliği; ayrı onay)

Mevcut "Windows — kripto, protokol ve ajan (SQLCipher yerel modülü)" işine eklenecek. İş adı **değişmez**, çünkü Ruleset bu adı zorunlu kontrol olarak tanıyor.

1. `pnpm --filter @saklaz/win-keyprotect run build` (MSVC, runner'da kurulu)
2. `pnpm --filter @saklaz/win-keyprotect run test`
3. Mevcut test komutu; artık `apps/agent` içinde DPAPI testlerini de içerir
4. İkinci kullanıcı testi (§4.2)
5. Bir bekçi adımı: Windows'ta DPAPI testlerinin **atlanmadan** koştuğunu doğrular (test raporundaki sayı > 0)

### 4.2 İkinci kullanıcıyla izolasyon testi (T-A3-22)

GitHub'ın Windows sanal makinesi geçicidir ve iş yönetici olarak çalışır; bu, test edilen B hesabının yönetici olması gerektiği anlamına gelmez.

**Mevcut CI kapsamı ve sınırı:** PR #12 betiği A'nın ham DPAPI blob'unu oluşturur; farklı SID'li B hesabında `UNPROTECT_FAILED` bekler; B'nin kendi DPAPI gidiş-dönüşünü ve A'nın kendi blob'unu yeniden açmasını doğrular. Bu gerçek Windows DPAPI testidir, ancak B'yi Administrators grubuna eklediği ve parolayı `net user` / `schtasks /rp` argümanlarına verdiği için güvenli kabul testi değildir. Ayrıca `ProtectedKeyStore` dosyasını test etmez.

**Kabul testi şu şekilde yeniden uygulanmalıdır:**

1. B, geçici **standart yerel kullanıcı** olarak oluşturulur; Administrators grubuna eklenmez ve yükseltilmiş görev çalıştırılmaz.
2. Parola, `SecureString` kabul eden yerel kullanıcı API'si veya eşdeğer güvenli Windows API'si ile işlenir. Parola `net user`, `schtasks /rp`, process argümanı, dosya veya günlük içine konmaz.
3. B süreci kendi profili yüklenerek başlatılır (ör. `Start-Process -Credential -LoadUserProfile` veya eşdeğer güvenli yöntem). Yalnızca test klasörüne gereken okuma/yazma ACL'i verilir.
4. **Ham blob alt testi:** A'nın DPAPI blob'u B tarafından açılmaya çalışılır; beklenen `UNPROTECT_FAILED`. B kendi DPAPI blob'unu açabilmeli; A da kendi blob'unu açabilmelidir.
5. **Gerçek kasa dosyası alt testi:** A'nın `kek.bin` dosyası B'nin okuyabildiği geçici konuma kopyalanır ve B adına `ProtectedKeyStore.load()` çağrılır; beklenen `BINDING_MISMATCH` (SID/MachineGuid bağlama kontrolü DPAPI unwrap'tan önce gelir). Dosyanın özeti değişmemelidir.
6. B kendi `kek.bin` dosyasını başarıyla açabilmelidir. Hiçbir sonuç dosyası KEK, blob veya düz metin içermemelidir.
7. Geçici görev/süreç, kullanıcı ve klasör temizlenir; temizlik hataları gizlenmez.

**Kabul kapısı:** Mevcut CI betiği bu koşullara göre düzeltilmeden T-A3-22 tamamlandı sayılmaz. Gerçek Windows 10/11 bilgisayar testi §5'te ayrıca zorunludur.

## 5. Gerçek Windows bilgisayarında doğrulama

Proje sahibi veya BT tarafından, `tools/devtest/windows/` test kitiyle yapılır (A10). Kit şirket verisine dokunmaz ve yalnızca geçici bir klasör kullanır.

| Adım | İçerik | Kayıt |
|---|---|---|
| W3.1 | Kurulum: yönetici **olmayan** bir kullanıcı | EDR veya SmartScreen uyarısı oldu mu? İmzasız yerel modül engellendi mi? |
| W3.2 | Kasa oluşturma, ajanı kapatma, **bilgisayarı yeniden başlatma**, kasayı açma | Geçti/kaldı |
| W3.3 | Kullanıcının **kendi parolasını değiştirmesi** → kasayı açma | Açılmalı |
| W3.4 | Aynı bilgisayarda **başka bir kullanıcı** hesabıyla açma denemesi | `UNWRAP_FAILED` |
| W3.5 | Kasa dosyasını **başka bir bilgisayara** kopyalayıp açma denemesi; mümkünse aynı etki alanı kullanıcısıyla, dolaşan profilde | `UNWRAP_FAILED` veya `BINDING_MISMATCH` |
| W3.6 | (Yalnızca bu amaçla açılmış bir **test hesabında**) yönetici parola sıfırlaması → açma denemesi | Yerel hesapta beklenen: açılmaz. Sonuç belgeye işlenir. |
| W3.7 | Antivirüs veya EDR açıkken 10.000 yazım | Hata sayısı, p95 süresi |
| W3.8 | Uyku ve hazırda bekletme sonrası açma | Geçti/kaldı |
| W3.9 | Kısıtlı PowerShell ortamı (AppLocker/WDAC) varsa | Yerel modül çalışıyor mu? |

**Kurallar:** Kit hiçbir şirket dosyasını okumaz ve ASEDEN'e bağlanmaz. Rapordan kullanıcı adı, makine adı, SID ve MachineGuid çıkarılır. W3.6 **asla gerçek bir kullanıcı hesabında yapılmaz.**

## 6. Kabul ölçütleri (A3)

1. Bütün GitHub CI işleri yeşil (Ruleset'teki 7 zorunlu kontrol + `analyze`).
2. T-A3-01…T-A3-56 geçti; geçemeyenler raporda nedeniyle birlikte gösterildi.
3. Mevcut hiçbir test silinmedi, atlanmadı veya gevşetilmedi; kapsama eşikleri değişmedi.
4. Diskte düz metin yok (T-A3-03); günlükte gizli değer yok (T-A3-40, T-A3-41).
5. Güvensiz kasaya geri düşüş yok (T-A3-14, T-A3-43, T-A3-44; negatif kontrollerle).
6. Kripto paketi, protokol paketi ve relay değişmedi.
7. `SECURITY.md`'de ilgili kontrol 🟨: "Windows CI'da doğrulandı; gerçek cihazda bekliyor". Gerçek cihaz raporu gelmeden ✅ **yapılmaz.**
