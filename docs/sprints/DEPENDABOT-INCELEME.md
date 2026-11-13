# Dependabot PR İncelemesi (#1–#5)

> **Tarih:** 2026-11-13
> **Taban:** `main` = `0cd9bec`
> **Kapsam:** Yalnızca inceleme. Hiçbir PR birleştirilmedi, kapatılmadı veya değiştirilmedi; workflow dosyalarına dokunulmadı.
> **Kaynaklar:** GitHub API (PR'lar, kontrol sonuçları, iş günlükleri); eylemlerin ilgili sürüm etiketlerinin git ile sığ klonu (`action.yml`, CHANGELOG, README).
> **Uygulama:** §2.3'teki birleşik çözüm proje sahibinin onayıyla **PR #10** olarak açıldı (`ci/codeql-v4`). PR #2 ve #5 açık bırakıldı; PR #10 birleştirildikten sonra kapatılmaları önerilecek.

## 1. Özet

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

**Yapılacak:** PR #2 ve #5'in CI'ını yeniden çalıştırmak bu iki hatayı kapatır, çünkü PR'ların test birleştirmesi artık güncel `main` ile yapılır. Ancak `analyze` hatası kalır (§2.1). Bu yüzden bu iki PR'ı tek tek düzeltmek yerine §2.3'teki birleşik PR önerilir.

**A3'e etkisi:** Aynı Windows dosya kilidi davranışı, A3'teki `vault.bin` atomik değiştirmesini de etkiler. Antivirüs veya EDR'ın geçici tanıtıcıları yüzünden `ERROR_SHARING_VIOLATION` alınabilir. Tasarımda sınırlı yeniden deneme ve `MoveFileExW(MOVEFILE_WRITE_THROUGH)` öngörüldü (SPRINT-3-A3-TEKNIK-TASARIM.md §8).

## 3. PR #1, #3, #4 — güncel `main` ile uyumluluk

Üçünün de CI'ı, güncel `main`'in A2 sonrası hali (`13afcf1`) üzerinde **8/8 yeşil**: Docker, Windows ve Dart dahil. Ruleset `strict` (dal güncel olmalı) olduğu için birleştirmeden önce her birinin `main`'in son haline güncellenmesi (`@dependabot rebase`) ve CI'ın yeniden yeşil olması gerekir.

### 3.1 Kırıcı değişiklikler (kaynak: eylemlerin kendi README ve CHANGELOG'ları)

| Eylem | Ana sürüm atlaması | Kırıcı değişiklikler | Bizim iş akışımıza etkisi |
|---|---|---|---|
| `actions/checkout` 4 → 7 | v5: `node24`. v6: kimlik bilgileri ayrı bir dosyada saklanıyor. v7: modül ESM; `pull_request_target` ve `workflow_run` için fork PR'ı checkout engeli; `--unset` değerleri kaçışlanıyor. | Runner ≥ 2.327.1 (GitHub runner'ı 2.338.2). | Etki yok: `pull_request_target` kullanmıyoruz. **Öneri:** Ayrı bir PR'da `persist-credentials: false` ile sıkılaştırma; iş akışlarımız checkout sonrasında git kimliğine ihtiyaç duymuyor. |
| `actions/setup-node` 4 → 7 | v5: `node24`; paket yöneticisi algılanırsa otomatik önbellek. v6: otomatik önbellek yalnızca npm için; `always-auth` kaldırıldı. v7: sahte `NODE_AUTH_TOKEN` yedeği kaldırıldı. | — | Etki yok: önbelleği zaten açıkça `cache: pnpm` ile veriyoruz; `always-auth` ve `registry-url` kullanmıyoruz. |
| `pnpm/action-setup` 4 → 6 | `node24`. Sürüm, `package.json`'daki `packageManager` alanından okunuyor. | — | Çalışıyor: önce pnpm v11 kuruluyor, sonra `packageManager` (`pnpm@10.28.0`) sürümüne geçiliyor; günlükte bir uyarı var (§4.3). |

### 3.2 Node 20 uyarısı

`main`'in güncel CI'ında `actions/checkout@v4.2.2` ve `codeql-action@v3` için *"Node.js 20 is deprecated … forced to run on Node.js 24"* uyarısı var. Dört yükseltmenin dördü de `node24` kullanıyor; birleştirildiklerinde bu uyarılar kalkar.

## 4. Riskler ve notlar

1. **Birlikte test edilmediler.** Her PR yalnızca kendi değişikliğiyle test edildi. Ruleset'in `strict` kuralı, her birleştirmeden sonra bir sonrakinin güncellenip yeniden test edilmesini zorunlu kıldığı için birleşim kendiliğinden test edilmiş olur.
2. **Çakışma.** #1, #3 ve #4 `ci.yml`'da komşu satırları değiştiriyor. Birinin birleştirilmesinden sonra diğerleri Dependabot tarafından yeniden kurulmalı; elle çakışma çözümü yapılmamalı.
3. **pnpm uyarısı.** `pnpm/action-setup@v6` önce pnpm v11'i kurup sonra 10.28.0'a geçiyor ve PATH düzeniyle ilgili bir uyarı veriyor. Şu an zararsız. pnpm 11'e geçiş ayrı bir karar konusu.
4. **CodeQL v3'ün kullanımdan kalkması** (Aralık 2026), #2/#5 çözümünü zamana bağlıyor.

## 5. Önerilen sıra

| Sıra | İşlem | Gerekçe |
|---|---|---|
| 1 | **CodeQL v4 birleşik PR'ı** (init + analyze aynı SHA ile) + Dependabot grup tanımı → #2 ve #5'i kapatma. **→ PR #10** | Kullanımdan kalkmaya 1 ay var; tek başına birleştirilirlerse `main` kilitlenir |
| 2 | **#3 checkout 7.0.1** | Bütün işler checkout kullanıyor; güvenlik iyileştirmeleri var |
| 3 | **#1 setup-node 7.1.0** | `node24`; bizi etkileyen kırıcı değişiklik yok |
| 4 | **#4 pnpm/action-setup 6.1.1** | `node24`; uyarı izlenecek |
| 5 | (İsteğe bağlı) `persist-credentials: false` sıkılaştırması | Ayrı, küçük bir PR |

Her adım: Dependabot ile güncel `main`'e yeniden kurma → 8/8 yeşil → sizin onayınızla "merge commit".

**A3'ten önce mi, sonra mı?** 1. adımın A3'ten önce yapılması önerilir: A3'te Windows CI işine yeni adımlar eklenecek; CodeQL'in v3'te kalması ise A3 sırasında `main`'i kilitleyebilir.
