# Dependabot PR İncelemesi (#1–#5)

> **Tarih:** 2026-11-14
> **Güncel taban:** `main` = `7a7742a` (`7a7742a513f577b1925044e7b3b143667cabb6a1`)
> **Kapsam:** Bu belge PR #1–#5 ve #10'un tarihsel incelemesini korur; aşağıdaki güncel durum bölümü 2026-11-14 itibarıyla kaynak gerçeğidir. Bu PR yalnızca dokümantasyon güncellemesidir; workflow/bağımlılık/kod değişikliği içermez.
> **Kaynaklar:** GitHub PR metadata/patch'leri, commit check-runs, Actions günlükleri, main workflow dosyaları ve K5 ruleset.
> **Uygulama:** PR #10 (`487a844862dc50db8d03ce13ee3afc9de1b1b954`) birleştirildi; PR #2 ve #5 birleştirilmeden kapatıldı. PR #1, #3 ve #4 de ayrı ayrı birleştirildi.

## Güncel durum (2026-11-14)

Bu bölüm, aşağıdaki 2026-11-13 tarihli tarihsel incelemedeki durum tablolarını ve önerilen sırayı geçersiz kılar.

| PR | Güncel durum | Merge commit | Merge sonrası main CI | Merge sonrası CodeQL |
|---|---|---|---|---|
| #1 setup-node 7.1.0 | Birleştirildi | `f634fa1183c15f950a5d144228b504e25d9f0430` | Başarılı (`43478003060`) | Başarılı (`43478003032`) |
| #3 checkout 7.0.1 | Birleştirildi | `d9ed76db6d221bb2e44ca277a7670312f8a45e05` | Başarılı (`43475288347`) | Başarılı (`43475288222`) |
| #4 pnpm/action-setup 6.1.1 | Birleştirildi | `7a7742a513f577b1925044e7b3b143667cabb6a1` | Başarılı (`43479165538`) | Başarılı (`43479165898`) |
| #2 CodeQL init v4.39.3 | Birleştirilmeden kapatıldı | — | Yerine #10 geçti | Yerine #10 geçti |
| #5 CodeQL analyze v4.39.3 | Birleştirilmeden kapatıldı | — | Yerine #10 geçti | Yerine #10 geçti |
| #10 CodeQL init + analyze v4.39.3 | Birleştirildi | `487a844862dc50db8d03ce13ee3afc9de1b1b954` | Sonraki main CI başarılı | Sonraki main CodeQL başarılı |

**Güncel main doğrulaması:** `7a7742a513f577b1925044e7b3b143667cabb6a1` üzerinde K5'in yedi zorunlu check-run'ı tamamlandı ve başarılı. CodeQL init/analyze aynı SHA (`33d7b85da1a04171e211befe2c739303b9a4c066`, v4.39.3) ile sabit. CI'da checkout v7.0.1, setup-node v7.1.0 ve pnpm/action-setup v6.1.1 SHA ile sabit; Node 22 ve `cache: pnpm` korunuyor.

**K5 koruması:** Ruleset `27197647` aktif; strict required checks açık, yedi zorunlu kontrol, yalnızca merge yöntemi, bypass aktörü yok. CodeQL güvenlik eşiği medium-or-higher, alert eşiği errors. Kural/ayar gevşetilmedi.

**PR #11 durumu (2026-11-14):** Bu doküman PR'ı (`docs/s3-a3-plan`) main'in 8 commit gerisinde ve bu düzeltmeden önce 4 commit ilerideydi (`main` = `7a7742a`, ortak taban `0cd9bec`); bu commit ile 5 commit ileridedir. Sayılar main ilerledikçe değişir; güncel değer PR sayfasındadır. Strict ruleset nedeniyle bu belge commit'leri dalı güncel main'e eşitlemez; PR, main tabanına göre yeniden doğrulanmadan birleştirilemez.

**Aşağıdaki bölümler tarihsel analizdir:** PR #1/#3/#4'ün merge öncesi durumu ve PR #10 için öneri, 2026-11-13 anlık görüntüsünü açıklar; artık yapılacak iş olarak okunmamalıdır.

## 1. Özet (2026-11-13 tarihsel inceleme)

| PR | Değişiklik | Taban | Kontroller | Değerlendirme |
|---|---|---|---|---|
| #1 | `actions/setup-node` 4.4.0 → **7.1.0** | `13afcf1` (güncel) | ✅ 8/8 | Uyumlu. `main`'in 7 commit gerisinde; birleştirmeden önce güncellenmeli. |
| #2 | `github/codeql-action/init` 3.29.5 → **4.39.3** | `0fbba5b` (**A0 öncesi**) | ❌ Windows, Dart, analyze | **Tek başına birleştirilemez.** #5 ile birlikte ele alınmalı (§2). |
| #3 | `actions/checkout` 4.2.2 → **7.0.1** | `13afcf1` (güncel) | ✅ 8/8 | Uyumlu. 7 commit geride. |
| #4 | `pnpm/action-setup` 4.1.0 → **6.1.1** | `13afcf1` (güncel) | ✅ 8/8 | Uyumlu; bir uyarı veriyor (§4.3). 7 commit geride. |
| #5 | `github/codeql-action/analyze` 3.29.5 → **4.39.3** | `0fbba5b` (**A0 öncesi**) | ❌ Windows, Dart, analyze | **Tek başına birleştirilemez.** #2 ile birlikte ele alınmalı (§2). |

Dependabot, `ci.yml`'ı değiştiren #1, #3 ve #4'ü A2 sonrasında güncel `main` üzerine yeniden kurmuş; bu üçünün CI'ı güncel kodla yeşil. `codeql.yml`'ı değiştiren #2 ve #5 ise `main`'de bu dosya hiç değişmediği için yeniden kurulmamış. Onların CI'ı 2026-11-12 19:07'de, A0 düzeltmelerinden önceki `main` üzerinde koşmuş ve o tarihten beri yeniden çalışmamış.

**Eylem commit SHA'larının doğrulanması:** Dört eylemin önerilen commit SHA'ları, kaynak depolarındaki sürüm etiketleriyle git üzerinden karşılaştırıldı. Hepsi birebir eşleşiyor (`33d7b85…` = codeql-action v4.39.3, `949feb2…` = setup-node v7.1.0, `3d3c42e…` = checkout v7.0.1, `73e4699…` = pnpm/action-setup v6.1.1). v4.39.3, CodeQL Action'ın en güncel 4.x sürümü (2026-11-04).

## 2. PR #2 ve #5 — CodeQL init/analyze sürüm uyuşmazlığı

### 2.1 Kök neden (günlüklerden)

CodeQL iş akışında `init` ve `analyze` iki ayrı adım. Dependabot her birini **ayrı bir PR'da** yükseltmiş; her PR'da biri v4'e geçmiş, diğeri v3'te kalmış. İki ana sürümün yapılandırma dosyası biçimi uyumsuz:

| PR | init | analyze | `analyze` işindeki hata |
|---|---|---|---|
| #2 | **v4.39.3** | v3.29.5 | `Cannot read properties of undefined (reading 'overlayDatabaseMode')`: v3 analyze, v4 init'in yazdığı yapılandırmayı okuyamıyor |
| #5 | v3.29.5 | **v4.39.3** | `Loaded configuration file, but it does not contain the expected 'version' field`: v4 analyze, v3 init'in yapılandırmasını reddediyor |

CodeQL kendisi de uyarıyor: *"Not all workflow steps that use `github/codeql-action` actions use the same version."*

**Sonuç:** Bu iki PR'dan hangisi tek başına birleştirilirse `main`'de CodeQL bozulur. Ruleset `CodeQL` kontrolünü ve kod taramasını zorunlu tuttuğu için, sonraki bütün PR'lar engellenir.

### 2.2 Aciliyet

CodeQL Action CHANGELOG'u (v4.39.3 etiketinde): *"CodeQL Action v3 will be deprecated in December 2026."* Yani yaklaşık bir ay sonra. Ayrıca `main`'in güncel CI günlüklerinde v3 için "Node.js 20 is deprecated … forced to run on Node.js 24" uyarısı var. v4.39.3 `node24` kullanıyor (`init/action.yml`, `analyze/action.yml`).

### 2.3 Önerilen çözüm

1. `init` ve `analyze`'ı **aynı commit SHA** (`33d7b85da1a04171e211befe2c739303b9a4c066`, v4.39.3) ile **tek bir değişiklikte** yükselten yeni bir PR. Bu PR'ı ayrı bir dalda ben açarım; birleştirme sizin onayınızla.
2. Yeni PR yeşil olunca #2 ve #5, "#N ile birlikte uygulandı" açıklamasıyla kapatılır. Dependabot, sürüm zaten güncel olduğu için onları yeniden açmaz.
3. Bundan sonra aynı sorunun tekrarlanmaması için `.github/dependabot.yml`'a bir **grup** tanımı:

   ```yaml
   groups:
     codeql-action:
       patterns: ["github/codeql-action*"]
   ```

   Bu, `codeql-action`'ın bütün alt eylemlerinin tek bir PR'da güncellenmesini sağlar.

Kontrol adları değişmez: `CodeQL` (GitHub Advanced Security) ve `analyze` (iş adı). Ruleset ayarı gerekmez.

**Uyumluluk:** v4.39.3 ile `security-extended` sorgu paketi ve `javascript-typescript` dili destekleniyor; mevcut `codeql.yml` girdileri v4'te kaldırılmış girdiler arasında değil. Bu, yeni PR'ın CI çalışmasıyla kesinleşecek; yerelde CodeQL çalıştırılamıyor.

### 2.4 PR #2 ve #5'teki Windows ve Dart hataları

Bu iki PR'daki iki hata da **A0'da düzeltilmiş eski hatalar.** PR'ların CI'ı A0 öncesindeki `main` üzerinde koştuğu için yeniden görünüyorlar. PR'ların kendi değişiklikleri (yalnızca `codeql.yml`) bu hatalarla ilgili değil.

| Hata | Günlükteki iz | Kök neden | Durum |
|---|---|---|---|
| Windows: 17 ajan testinden 14'ü `EBUSY: resource busy or locked, unlink '…\agent.db'` | `apps/agent test: ❯ test/agent.test.ts (17 tests \| 14 failed)` | (a) **Üretim kodu:** `openAgentDb`, yanlış anahtar (SQLITE_NOTADB) veya bozuk dosya gibi açılış hatalarında SQLCipher tanıtıcısını kapatmadan hata fırlatıyordu; `AgentCore` kurucusu da veritabanı açıldıktan sonraki bir hatada tanıtıcıyı açık bırakıyordu. (b) **Testler:** ajanları kapatmıyordu. Windows, açık bir dosyanın silinmesine izin vermez; Linux izin verdiği için bu hata orada görünmüyordu. | ✅ A0'da düzeltildi (`3175947`, `main`'de) |
| Dart: "İşleme bağlı onay" testi; özet `kLEdCGwf…` beklenirken `sxeCQzv5…` | `vectors_test.dart` | v0.3'te onay özetine ve telefonun imzaladığı baytlara eklenen `ws` (çalışma alanı) alanı, Sprint 1'de yazılıp hiç çalıştırılmamış Dart testinde eksikti. **Kripto veya JCS uyuşmazlığı değil.** | ✅ A0'da düzeltildi. Vektöre `digestInputHex` eklendi; Dart önce özet girdisinin baytlarını karşılaştırıyor. |

**`agent.db` için güvenli kapatma yöntemi** (A0'da uygulandı, `main`'de):

1. `openAgentDb` açılıştan sonraki her adımı (`cipher`, `key`, `journal_mode=WAL`, `synchronous`, `foreign_keys`, migration) `try` bloğunda yapar. Hata olursa `db.close()` çağırır ve hatayı yeniden fırlatır.
2. `AgentCore` kurucusu, veritabanı açıldıktan sonraki bütün kurulumu `try` içinde yapar; hata olursa veritabanını kapatır.
3. `AgentCore.close()` birden fazla çağrılabilir (`if (db.open) db.close()`).
4. Testlerde `afterEach`, klasörü silmeden önce bütün ajanları kapatır. Klasör silme hatası yutulmaz.
5. Regresyon testleri platforma göre doğrular: Linux'ta `/proc/self/fd`, Windows'ta açık dosyanın yeniden adlandırılamaması. Düzeltme geri alınınca test kırmızı oluyor (negatif kontrol yapıldı).

**Güncel sonuç:** Bu tarihsel öneri PR #10 ile uygulandı. PR #2 ve #5 birleştirilmeden kapatıldı; güncel main'de CodeQL init ve analyze aynı v4.39.3 SHA'sını kullanıyor ve main CodeQL kontrolü başarılı.

**A3'e etkisi:** Aynı Windows dosya kilidi davranışı, A3'teki `vault.bin` atomik değiştirmesini de etkiler. Antivirüs veya EDR'ın geçici tanıtıcıları yüzünden `ERROR_SHARING_VIOLATION` alınabilir. Tasarımda sınırlı yeniden deneme ve `MoveFileExW(MOVEFILE_WRITE_THROUGH)` öngörüldü (SPRINT-3-A3-TEKNIK-TASARIM.md §8).

## 3. PR #1, #3, #4 — güncel `main` ile uyumluluk

#1, #3 ve #4 ayrı ayrı birleştirildi. Her merge sonrasında main CI ve CodeQL başarılı oldu; kesin commit ve run kimlikleri yukarıdaki güncel durum tablosundadır. Bu PR'ların workflow patch'leri yalnızca beklenen action SHA satırlarını değiştirdi.

### 3.1 Kırıcı değişiklikler (kaynak: eylemlerin kendi README ve CHANGELOG'ları)

| Eylem | Ana sürüm atlaması | Kırıcı değişiklikler | Bizim iş akışımıza etkisi |
|---|---|---|---|
| `actions/checkout` 4 → 7 | v5: `node24`. v6: kimlik bilgileri ayrı bir dosyada saklanıyor. v7: modül ESM; `pull_request_target` ve `workflow_run` için fork PR'ı checkout engeli; `--unset` değerleri kaçışlanıyor. | Runner ≥ 2.327.1 (GitHub runner'ı 2.338.2). | Etki yok: `pull_request_target` kullanmıyoruz. **Öneri:** Ayrı bir PR'da `persist-credentials: false` ile sıkılaştırma; iş akışlarımız checkout sonrasında git kimliğine ihtiyaç duymuyor. |
| `actions/setup-node` 4 → 7 | v5: `node24`; paket yöneticisi algılanırsa otomatik önbellek. v6: otomatik önbellek yalnızca npm için; `always-auth` kaldırıldı. v7: sahte `NODE_AUTH_TOKEN` yedeği kaldırıldı. | — | Etki yok: önbelleği zaten açıkça `cache: pnpm` ile veriyoruz; `always-auth` ve `registry-url` kullanmıyoruz. |
| `pnpm/action-setup` 4 → 6 | `node24`. Sürüm, `package.json`'daki `packageManager` alanından okunuyor. | — | Çalışıyor: önce pnpm v11 kuruluyor, sonra `packageManager` (`pnpm@10.28.0`) sürümüne geçiliyor; günlükte bir uyarı var (§4.3). |

### 3.2 Node 20 uyarısı

Bu uyarı 2026-11-13 tarihli tarihsel main için geçerliydi. Güncel main'de checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.1 ve CodeQL Action v4.39.3 kullanılıyor; setup-node adımında Node 22 açıkça seçiliyor.

## 4. Riskler ve notlar

1. #1, #3 ve #4 sıralı olarak birleştirildi; her merge sonrasında main CI ve CodeQL başarılı.
2. #2 ve #5 tek başına birleştirilmedi; #10 aynı SHA'lı init/analyze güncellemesini sağladı ve iki eski PR kapatıldı.
3. pnpm v6.1.1'in kurulum/versiyon seçimi uyarısı tarihsel CI günlüklerinde not edilmişti; mevcut main testleri başarılı. pnpm sürümüne geçiş ayrı karar olarak kalır.
4. CodeQL v3 geçiş riski #10 ile giderildi; main artık v4.39.3 kullanıyor.

## 5. Önerilen sıra

| Sıra | İşlem | Gerekçe |
|---|---|---|
| 1 | **Tamamlandı: PR #10** — CodeQL init/analyze aynı v4.39.3 SHA; Dependabot grubu eklendi; #2/#5 birleştirilmeden kapatıldı | Main CodeQL başarılı |
| 2 | **Tamamlandı: PR #3** — checkout 7.0.1 | Merge sonrası CI/CodeQL başarılı |
| 3 | **Tamamlandı: PR #1** — setup-node 7.1.0 | Merge sonrası CI/CodeQL başarılı |
| 4 | **Tamamlandı: PR #4** — pnpm/action-setup 6.1.1 | Merge sonrası CI/CodeQL başarılı |
| 5 | (İsteğe bağlı, ayrı karar) `persist-credentials: false` sıkılaştırması | Bu PR kuyruğunun kapsamı dışında; ayrı inceleme gerekir |

Yukarıdaki dört birleştirme tamamlandı. Yeni action güncellemeleri aynı SHA sabitleme ve zorunlu kontroller sürecinden geçmelidir.

**A3'ten önce mi, sonra mı?** 1. adımın A3'ten önce yapılması önerilir: A3'te Windows CI işine yeni adımlar eklenecek; CodeQL'in v3'te kalması ise A3 sırasında `main`'i kilitleyebilir.
