# Faz 1 (MVP) Planı

> **Sürüm:** v0.1, 2026-11-12
> **Durum:** Onay bekliyor. Bu plan onaylanmadan uygulama kodu yazılmayacak.
> **Bağlam:** ARCHITECTURE.md v0.2, SECURITY.md v0.2, docs/FAZ0-RAPOR.md

## 0. Kabul Edilen Kararlar (proje sahibi, 2026-11-12)

| # | Karar | Plana etkisi |
|---|---|---|
| D1 | E2EE ve her komutun telefonda imzalanması korunur. +2 hafta kabul edildi. | §4, §5 |
| D2 | Relay şirket içi sanal makinede çalışır. Dış erişim yalnızca 443 üzerinden, ters proxy ve güvenlik katmanlarıyla sağlanır. Windows ajanına gelen (inbound) bağlantı yoktur. | §9 |
| D3 | FCM yalnızca içeriksiz uyandırma için kullanılır. | §3.6 |
| D4 | ASEDEN keşfi salt okunurdur; ASEDEN yöneticisi ve IT ile koordineli yürütülür. Motor doğrulanmadan entegrasyon kodu yazılmaz. | §12 |
| D5 | MVP, ASEDEN'den tamamen bağımsızdır ve yalnızca sentetik test verisi kullanır. ASEDEN ayrı modüldür. | §10.4, §12 |
| D6 | Windows envanter betiği gerçek Windows'ta test edilir. | §10.6 |

## 1. Uzun Vadeli Hedef ve Faz 1'in Yeri

SAKLAZ AI'nın hedefi şu alanları **tek bir güven modeli altında** yönetebilen bir ajan olmaktır: bilgisayar, telefon, ofis işleri ve ASEDEN.

Bu yüzden Faz 1 yalnızca "dosya özetleyen bir uygulama" değildir. Sonraki bütün yeteneklerin üzerine oturacağı **güvenli çekirdek**tir:

- Kimlik
- Eşleştirme
- İmzalı komut
- E2EE
- Politika motoru
- Araç çerçevesi
- Denetim kaydı

Faz 2–4'te eklenecek her yetenek bir **araç** olarak tanımlanır: ERP, e-posta, tarayıcı, ekran ve telefon eylemleri. Bu araçlar risk seviyesi ve izinleriyle bu çekirdeğe takılır; güvenlik mimarisi yeniden yazılmaz.

**Faz 1 kapsamı:** Güvenli çekirdek, dosya ve rapor araçları, Excel ve Raporlama ile Kişisel Asistan ajanları, relay, masaüstü UI, Android uygulaması.

**Faz 1 dışı:** ASEDEN, Outlook, sesli komut, bilgisayar kontrolü (izin çerçevesi Faz 1'de tasarlanır ve kodlanır, kontrol araçları Faz 3'te eklenir).

## 2. Windows Agent Mimarisi

### 2.1 Süreçler

```
Windows kullanıcı oturumu
├── saklaz-agent.exe       (Node.js, arka plan, kullanıcı yetkisi)
│     ├── core             transport · verifier · router · orchestrator · policy · store · audit
│     └── worker havuzu    güvenilmez dosya ayrıştırma ve rapor üretimi (ayrı alt süreçler)
├── saklaz-desktop.exe     (Electron UI, isteğe bağlı açılır)
└── [Faz 3] saklaz-ui-automation  (bilgisayar kontrolü, ayrı izinli süreç)
```

| Karar | Gerekçe |
|---|---|
| Ajan **kullanıcı yetkisiyle** çalışır. SYSTEM ve yönetici yetkisi kullanılmaz. | Ajan ele geçirilse bile kullanıcının zaten erişebildiğinin ötesine geçemez. Kurulum yönetici yetkisi gerektirmez. |
| Başlatma, kullanıcı oturumu açılışında Görev Zamanlayıcı ile yapılır. | Windows Hizmeti, kullanıcı masaüstüne erişemez ve SYSTEM gerektirir. Bu konu Faz 3'te yeniden değerlendirilecek. |
| UI ve ajan ayrı süreçlerdir; aralarında ACL'li named pipe vardır. | UI kapalıyken uzaktan görevler çalışır. UI'daki bir hata çekirdeği etkilemez. |
| Güvenilmez dosya ayrıştırma (xlsx, pdf, docx) **ayrı alt süreçte** çalışır. Bu süreçte zaman aşımı, bellek sınırı vardır; ağ erişimi ve gizli bilgi yoktur. | Kötü niyetli veya bozuk bir dosya çekirdeği çökertemez ve anahtarlara erişemez. |
| Tek örnek kilidi (single instance mutex) kullanılır. | İki ajanın aynı anahtarla yarışması engellenir. |

### 2.2 Çekirdek katmanları ve mesaj işleme sırası

```
WSS (relay) ──► transport ──► crypto (Noise çözme) ──► verifier ──► router ──► orchestrator ──► policy ──► tools
                                                          │                                          │
                                                          └── reddedilen her şey ──► audit ◄─────────┘
```

| Katman | Görevi |
|---|---|
| `transport` | Giden WSS bağlantısı, heartbeat, yeniden bağlanma, outbox ve inbox. |
| `crypto` | Noise oturumları, mühürlü zarflar, dosya parçası şifreleme. |
| `verifier` | Sıralama §4.4'te. Bu katmanı geçmeyen mesajın router'a ulaşmaması tasarım gereğidir ve testle doğrulanır. |
| `router` | Mesaj tipine göre yönlendirir: komut, iptal, onay, geçmiş sorgusu, dosya talebi. |
| `orchestrator` | Komutu plana çevirir. AI yoksa RuleEngine, varsa yerel model kullanır. Planı adım adım çalıştırır. |
| `policy` | Her adım için şu kararı verir: izin ver, onay iste veya reddet. Model değil, bu katman karar verir. |
| `tools` | Zod şemalı, risk seviyeli araçlar. |
| `store` | SQLCipher ile şifreli SQLite. Anahtar DPAPI'dedir. |
| `audit` | Hash zincirli denetim kaydı. |

### 2.3 Araç çerçevesi (genişletilebilirliğin temeli)

```ts
interface Tool<I, O> {
  key: `${string}.${string}`;        // "fs.list", "xlsx.read", "report.create"
  version: number;
  risk: "read" | "write" | "critical";
  capability: Capability;            // "files", "screen", "apps", "browser", "erp", "email"...
  input: ZodType<I>;
  output: ZodType<O>;
  describeForApproval?(input: I): ApprovalView;  // onay ekranında gösterilecek gerçek parametreler
  run(input: I, ctx: ToolContext): Promise<O>;  // ctx: grant'ler, iptal sinyali, worker havuzu, audit
}
```

- Araçlar kayıt defterine (registry) derleme anında eklenir. Çalışma zamanında dışarıdan araç yüklenmez. Eklenti sistemi ileride, imza doğrulamasıyla birlikte gelecektir.
- Her aracın birim testi ve `policy` ile entegrasyon testi zorunludur.

**Faz 1 araçları:**

| Araç | Risk |
|---|---|
| `fs.list` | `read` |
| `fs.search` | `read` |
| `fs.stat` | `read` |
| `xlsx.read` | `read` |
| `xlsx.analyze` (toplam, grupla, filtrele, karşılaştır) | `read` |
| `pdf.readText` | `read` |
| `docx.readText` | `read` |
| `report.createXlsx` | `write` |
| `report.createDocx` | `write` |
| `report.createPdf` | `write` |
| `fs.copyToOutput` | `write` |
| `fs.moveToRecycleBin` | `critical` |
| `fs.overwrite` | `critical` |
| `file.sendToPhone` | `write`; politika "dosya cihazdan çıkamaz" ise `critical` |

### 2.4 Yaşam döngüsü

| Olay | Davranış |
|---|---|
| İlk kurulum | Kimlik anahtarları üretilir (§5). Kullanıcı bir yönetici PIN'i belirler: bu PIN, Windows Hello yoksa yedek yerel onaydır. Varsayılan olarak hiçbir klasör erişimi yoktur. |
| Başlatma | Anahtarlar DPAPI'den açılır. Relay'e bağlanılır. Kesinti öncesinde yarım kalan görevler kontrol edilir (§8). |
| Güncelleme | İmzalı paket indirilir. İmza, sabitlenmiş yayın anahtarıyla doğrulanır. Çalışan görev yoksa yeniden başlatılır. Güncelleme kanalı relay'den ayrıdır. |
| Kaldırma | Anahtarlar ve yerel veritabanı silinir. Relay'e bir iptal bildirimi gönderilir. Çıktı klasörüne dokunulmaz. |

## 3. Android: Güvenli Cihaz Eşleştirme

Protokolün kriptografik ayrıntısı SECURITY.md §4'te. Bu bölüm akışı, durumları ve hata yollarını tanımlar.

### 3.1 Ön koşullar

- Telefon, relay hesabına MFA ile giriş yapmış olmalıdır. Bu yalnızca relay'e bağlanma yetkisi verir.
- Telefonda ekran kilidi ve biyometrik doğrulama etkin olmalıdır. Değilse eşleştirme başlamaz.
- Keystore donanım destekli olmalıdır (TEE veya StrongBox). Yazılım tabanlı Keystore varsa kullanıcı uyarılır. Organizasyon politikası bu durumda eşleştirmeyi reddedebilir.

### 3.2 Akış

```
Windows (masaüstü UI)                     Relay                         Android
─────────────────────                     ─────                         ───────
1. "Telefon Eşleştir" (yerel kullanıcı;
   Windows Hello veya yönetici PIN'i)
2. S (256 bit), expiresAt (5 dk) üret
   pairing_session aç ──────────────────► kayıt (S YOK)
3. QR göster:
   {v, relayUrl, agentId, agentSignPub,
    agentDhPub, sessionId, S, expiresAt}
                                                                        4. QR oku; süre ve sürüm kontrolü
                                                                        5. Keystore'da anahtar üret:
                                                                           Ed25519 (biyometriye bağlı),
                                                                           X25519
                                                                        6. PairRequest = AEAD_{HKDF(S,"pair-req")}(
                                                                             phoneId, phoneSignPub, phoneDhPub,
                                                                             deviceModel, Keystore attestation zinciri)
                                         ◄──────────────────────────── gönder (sessionId'ye)
7. Çöz; attestation zincirini doğrula
   (Google kök sertifikası; politikaya göre)
8. SAS = ilk 6 hane(BLAKE2b("SAKLAZ-SAS-v1",
   S, agent pub'ları, phone pub'ları))
   Göster; rol seçimi: owner / operator / viewer
                                                                        9. SAS göster
10. Kullanıcı iki ekranda da "eşleşiyor" der
11. PairConfirm = AEAD_{HKDF(S,"pair-ok")}(
     role, agentSig(transcript)) ──────────────────────────────────────►
                                                                        12. agentSig doğrula; anahtarları sabitle
                                                                            Telefon, transcript'i imzalar ──►
13. phoneSig doğrula; paired_devices'a yaz;
    audit; S'yi bellekten sil
```

**Önemli noktalar:**

- **Karşılıklı transcript imzası:** Her iki taraf da eşleştirme sürecinin tamamını (transcript) imzalar. Böylece tek taraflı eşleştirme olamaz.
- **Rol seçimi:** Rolü **Windows tarafında**, yerel kullanıcı belirler. Telefon kendi rolünü kendisi seçemez.
- **Keystore attestation:** Telefon anahtarının gerçekten donanımda üretildiğini ve dışa aktarılamaz olduğunu kanıtlar. Root'lu veya emülatör cihazlar organizasyon politikasıyla reddedilebilir.

### 3.3 Hata ve saldırı yolları

| Durum | Davranış |
|---|---|
| QR süresi doldu | Telefonda "Kod süresi doldu" mesajı gösterilir. Windows'ta yeni kod üretilir. |
| AEAD çözülemedi (yanlış S veya relay müdahalesi) | Oturum kapatılır. Denetim kaydına "eşleştirme bütünlük hatası" yazılır. Telefona ayrıntı verilmez. |
| SAS uyuşmuyor | Kullanıcı "uyuşmuyor" seçer. Oturum iptal edilir ve olası müdahale olarak kaydedilir. |
| Bir oturumda 3 başarısız deneme | Oturum kalıcı olarak kapatılır. |
| Aynı telefon yeniden eşleşmek istiyor | Eski kayıt iptal edilir ve yeni anahtarlarla kayıt açılır. Eski anahtar bir daha kabul edilmez. |

### 3.4 İptal ve kurtarma

| Senaryo | İşlem |
|---|---|
| Telefon kayboldu | Windows'ta "Cihazlar → İptal" seçilir (yerel kullanıcı ve Windows Hello). İptal hemen geçerli olur. Relay'e bildirilir; ancak iptalin geçerli olması relay'e bağlı değildir. |
| İkinci telefondan iptal | `owner` rolündeki bir telefon, başka bir telefonu imzalı bir komutla iptal edebilir (`critical`). |
| Tek telefon kayboldu, Windows'a erişim yok | Uzaktan kurtarma **yoktur**. Bu bilinçli bir tasarım kararıdır: kurtarma mekanizması, saldırganın da kullanabileceği bir arka kapı olur. Windows'a fiziksel erişimle yeniden eşleştirme yapılır. |

### 3.5 Android güvenlik ayarları

- `FLAG_SECURE`: Onay ve geçmiş ekranlarında ekran görüntüsü alınması ve son uygulamalar önizlemesi engellenir.
- Uygulama verisi SQLCipher ile şifrelenir. Anahtar Keystore'da tutulur.
- `android:allowBackup="false"` ayarlanır. Anahtarlar ve veriler bulut yedeğine gitmez.
- Relay TLS açık anahtarı uygulamaya sabitlenir (pinning). Bu sabitleme bir yedek pin içerir ve sertifika yenilenirken kesinti olmaması için planlanır.
- Root, emülatör veya hata ayıklayıcı tespiti için Play Integrity API kullanılır (opsiyonel). Tespit durumunda kullanıcı uyarılır ve organizasyon politikasıyla erişim engellenebilir.

### 3.6 Push bildirimi (D3)

FCM ile gönderilen veri:

```
{"t":"w","v":1}
```

Bu, sabit uzunlukta bir uyandırma sinyalidir. Gönderilmeyenler: görev kimliği, görev türü, kullanıcı adı, sayı veya zaman damgası.

Telefon bu sinyali alınca uyanır, relay'e bağlanır ve E2EE kanaldan içeriği çeker. Bildirim metni ("Onay bekleyen 1 işlem") yerel olarak, şifre çözme sonrasında oluşturulur.

## 4. İmzalı Komut Protokolü

### 4.1 Katmanlar

```
WSS (TLS 1.3, relay'e kadar)
 └─ Dış zarf (relay okur):    { v, id, from, to, kind, ttl, size, ct }
     └─ Noise_KK oturumu veya mühürlü zarf (yalnız uç cihazlar)
         └─ İç mesaj:         { hdr, body, sig }
```

### 4.2 İç mesaj

```jsonc
{
  "hdr": {
    "proto": "saklaz/1",
    "type": "cmd.create",          // aşağıdaki listeye bakın
    "msgId": "01J...",             // UUIDv7, gönderen üretir
    "from": "dev_phone_...",
    "to":   "dev_agent_...",
    "ctr":  1842,                  // gönderen→alıcı için monoton sayaç
    "ts":   "2026-11-12T17:02:11Z",
    "nonce":"base64(16 bayt)"
  },
  "body": {
    "taskId": "01J...",
    "text": "Raporlar klasöründeki Excel dosyalarını özetle",
    "agent": "reporting",
    "options": { "outputFormat": "xlsx" },
    "expiresAt": "2026-11-13T17:02:11Z"
  },
  "sig": "base64(Ed25519)"
}
```

İmza şöyle hesaplanır:

```
sig = Ed25519.sign(senderSignKey, "SAKLAZ-v1/msg\x00" || JCS(hdr) || "\x00" || JCS(body))
```

- **Alan ayrımı (domain separation):** Önekler (`SAKLAZ-v1/msg`, `SAKLAZ-v1/approval`, `SAKLAZ-v1/pair`) sayesinde bir bağlamda üretilmiş imza başka bir bağlamda kullanılamaz.
- **Kanonik biçim:** JCS (RFC 8785) kullanılır. Böylece TS ve Dart aynı baytları imzalar. Bu, test vektörleriyle doğrulanır.

### 4.3 Mesaj tipleri (Faz 1)

| Tip | Yön | Açıklama |
|---|---|---|
| `cmd.create` | telefon → ajan | Yeni görev. |
| `cmd.cancel` | telefon → ajan | Görevi iptal et. Yalnızca görevi oluşturan veya `owner`. |
| `task.event` | ajan → telefon | Durum, ilerleme, sonuç özeti (imzalı). |
| `approval.request` | ajan → telefon | Onay isteği (ajan imzalı, `challenge` içerir). |
| `approval.decision` | telefon → ajan | Onay veya ret (biyometrik imza). |
| `history.query` / `history.page` | telefon ↔ ajan | Görev geçmişi ajandan çekilir; relay'de geçmiş yoktur. |
| `file.request` / `file.offer` / `file.chunk` | telefon ↔ ajan | Dosya aktarımı (§5.5). |
| `device.revoke` | telefon → ajan | Başka bir telefonu iptal et (`owner`, `critical`). |
| `grant.request` | telefon → ajan | İzin genişletme talebi (`owner`, `critical`; politikaya göre yalnızca yerel). |
| `ack` | her iki yön | Uçtan uca teslim onayı (§6.3). |

Kontrol mesajları (`ping`, `presence`, `queue.drained`) **iç mesaj değildir**. Relay ile cihaz arasındadır ve ayrı bir şemayla tanımlanır. Router bu mesajları hiçbir koşulda orkestratöre iletmez.

### 4.4 Ajandaki doğrulama sırası (değiştirilemez)

1. Dış zarfın boyut ve şema kontrolü yapılır. Boyut sınırı aşılırsa mesaj okunmadan atılır.
2. Mesajın şifresi Noise veya mühürlü zarfla çözülür. Başarısız olursa mesaj reddedilir ve denetim kaydına yazılır.
3. İç mesajın zod şeması kontrol edilir.
4. `from`, `paired_devices` tablosunda olmalı, iptal edilmemiş olmalı ve `to` bu ajan olmalıdır.
5. **İmza** doğrulanır: sabitlenmiş açık anahtar ve alan ayrımı öneki kullanılır.
6. **Replay koruması:** `ctr` son kabul edilen sayaçtan büyük olmalı, `nonce` daha önce görülmemiş olmalı ve `ts` kabul penceresi (§8.4) içinde kalmalıdır.
7. **Rol yetkisi:** Gönderen rolün bu mesaj tipine izni olmalıdır (§6).
8. Sayaç kalıcı olarak kaydedilir. Mesaj işlenmeden **önce** kaydedilir; böylece çökme sonrası aynı mesaj tekrar oynatılamaz.
9. Mesaj router'a, oradan orkestratöre ve politika motoruna geçer.

Her adımın başarısızlığı **tipli bir hata** üretir ve denetim kaydına yazılır. Gönderene ayrıntısız, imzalı bir ret mesajı döner. Ret mesajları saldırgana bilgi sızdırmayacak biçimde tasarlanır.

### 4.5 Sürümleme

- `proto` alanı ana sürümü taşır. Ajan, desteklemediği sürümü reddeder.
- Ajan, el sıkışmada desteklediği sürüm aralığını ve araç listesini telefona bildirir. Telefon, ajanın desteklemediği bir komutu göndermez.

## 5. Uçtan Uca Şifreleme ve Anahtar Yönetimi

### 5.1 Anahtar envanteri

| Anahtar | Tür | Nerede | Ömür | Yenileme |
|---|---|---|---|---|
| Telefon kimlik imza anahtarı | Ed25519 | Android Keystore (donanım, biyometriye bağlı, dışa aktarılamaz) | Cihaz ömrü | Elle (§5.4) |
| Telefon kimlik DH anahtarı | X25519 | Keystore ile sarılı (wrapped) | Cihaz ömrü | Elle |
| Ajan kimlik imza anahtarı | Ed25519 | DPAPI (kullanıcı kapsamı) | Kurulum ömrü | Elle (§5.4) |
| Ajan kimlik DH anahtarı | X25519 | DPAPI | Kurulum ömrü | Elle |
| Noise oturum anahtarları | Geçici | Yalnızca bellek | ≤ 24 saat veya 10.000 mesaj | Otomatik |
| Eşleştirme sırrı `S` | 256 bit | Yalnızca QR ve bellek | ≤ 5 dk, tek kullanım | — |
| Dosya anahtarı | 256 bit, dosya başına | Yalnızca bellek ve E2EE mesaj içinde | Tek aktarım | — |
| Ajan yerel DB anahtarı | 256 bit | DPAPI | Kurulum ömrü | Opsiyonel yeniden şifreleme |
| Telefon yerel DB anahtarı | 256 bit | Keystore | Kurulum ömrü | — |
| Yayın (güncelleme) imza anahtarı | Ed25519 | Çevrimdışı ortam (HSM veya ayrılmış makine) | Uzun | Planlı, iki anahtarlı geçiş |
| Kod imzalama sertifikası | X.509 (OV veya EV) | Sağlayıcı token'ı veya HSM | Sertifika süresi | Yenileme |
| Relay TLS anahtarı | ECDSA P-256 | Relay VM (ters proxy) | 90 gün (ACME) veya şirket CA | Otomatik |
| Relay JWT imza anahtarı | Ed25519 | Docker secret | 90 gün | Örtüşmeli rotasyon |
| MFA şifreleme anahtarı | AES-256 | Docker secret | Uzun | Yeniden şifreleme betiği |

### 5.2 Noise oturumu

- **Desen:** `Noise_KK_25519_ChaChaPoly_BLAKE2b` (ADR-0008: libsodium BLAKE2s içermez).
- **Prologue (önsöz):** `"SAKLAZ-v1" || agentId || phoneId || proto`. Önsöz, oturumu cihaz kimliklerine ve protokol sürümüne bağlar; böylece sürüm düşürme (downgrade) saldırısı olamaz.
- **Taşıma:** El sıkışma mesajları relay üzerinden normal zarflarla taşınır. Relay bunları ayırt edemez.
- **Yenileme:** Oturum 24 saatte bir veya 10.000 mesajda bir yeniden kurulur; hangisi önce gelirse. Her iki taraf da yenileme başlatabilir.

### 5.3 Çevrimdışı alıcıya mesaj

Alıcı çevrimdışıyken Noise el sıkışması yapılamaz. Bu durumda:

```
eph = X25519.generate()
k   = HKDF(X25519(eph, recipientDhPub) || X25519(senderDh, recipientDhPub), "SAKLAZ-v1/sealed")
ct  = XChaCha20-Poly1305(k, nonce, innerMessage(imzalı))
```

- Gönderenin statik DH anahtarı da karıştırılır. Böylece alıcı, mesajın kimden geldiğini anahtar düzeyinde de doğrular.
- Sınırlı ileri gizlilik kabul edilmiştir; ADR-0007 olarak belgelenecek.

### 5.4 Kimlik anahtarı yenileme (rotasyon)

- **Planlı yenileme:** Yeni anahtar üretilir. Eski anahtarla imzalı `key.rotate {newSignPub, newDhPub}` mesajı karşı tarafa gönderilir. Karşı taraf yeni anahtarı sabitler. Eski anahtar 7 gün boyunca yalnızca doğrulama için tutulur, sonra silinir.
- **Ele geçirilme şüphesi:** Rotasyon değil **iptal ve yeniden eşleştirme** yapılır. Ele geçirilmiş anahtarın imzaladığı bir rotasyona güvenilmez.

### 5.5 Dosya aktarımı

1. Ajan rastgele bir dosya anahtarı `fk` ve `fileId` üretir. `file.offer {fileId, name, size, sha256, fk, chunkCount}` mesajını imzalı ve E2EE olarak gönderir.
2. Her parça şöyle şifrelenir:

   ```
   AEAD(fk, nonce = fileId || chunkIndex, data, aad = fileId || chunkIndex || chunkCount)
   ```

   Bu yöntem parçaların sırasının değiştirilmesini, kesilmesini veya çoğaltılmasını engeller.
3. Telefon dosyayı birleştirir ve `sha256` değerini doğrular. Uyuşmazsa dosya silinir ve olay kaydedilir.
4. Relay parçaları yalnızca TTL süresince tutar. Teslim sonrası parçalar silinir.

### 5.6 Kripto uygulama kuralları

- Kriptografi yalnızca libsodium üzerinden yapılır. Noise, denetlenmiş bir JS uygulaması varsa onunla, yoksa libsodium primitifleri üzerine ince ve tamamen test vektörlü bir katmanla uygulanır. Bu seçim ADR-0008 ile Sprint 1'de yapılacak.
- **Dart tarafı:** Seçilecek libsodium bağlaması, Sprint 1'de bir uyumluluk spike'ıyla doğrulanacak.
- **Gizli veri karşılaştırma:** Sabit zamanlı karşılaştırma kullanılır. Anahtarlar mümkün olduğunca `Uint8Array` içinde tutulur ve kullanım sonrası sıfırlanır.

## 6. Kullanıcı ve Cihaz Yetkilendirmesi

### 6.1 İki katmanlı model

| Katman | Kim karar verir? | Neyi yetkilendirir? |
|---|---|---|
| **Relay hesabı ve organizasyon rolü** | Relay yöneticisi | Relay'e bağlanma, cihaz kaydı, organizasyon ayarları. **Ajana komut yetkisi vermez.** |
| **Cihaz rolü (ajan üzerinde)** | Windows'taki yerel kullanıcı, eşleştirme sırasında | Ajana hangi komutların gönderilebileceği, kimin onay verebileceği. |

Bu ayrım bilinçlidir. Relay yöneticisi veya relay'i ele geçiren biri, yalnızca relay'deki yetkiyle ajan üzerinde işlem yaptıramayacak şekilde tasarlanmıştır (SECURITY.md §0 varsayımları altında).

### 6.2 Cihaz rolleri ve izinler

| Eylem | `owner` | `operator` | `viewer` | Yerel kullanıcı (masaüstü) |
|---|---|---|---|---|
| Görev oluşturma (`read`/`write` araçlar) | ✅ | ✅ | ❌ | ✅ |
| `critical` onay verme | ✅ | Politikaya bağlı (varsayılan ❌) | ❌ | ✅ (Windows Hello) |
| Görev iptali | ✅ (tümü) | ✅ (kendininki) | ❌ | ✅ |
| Geçmiş ve sonuç görüntüleme | ✅ | ✅ (kendininki) | ✅ | ✅ |
| Dosyayı telefona çekme | ✅ | ✅ | ❌ | — |
| Klasör izni ekleme | Politikaya bağlı (`critical`) | ❌ | ❌ | ✅ |
| Başka cihazı iptal etme | ✅ (`critical`) | ❌ | ❌ | ✅ |
| Rol değiştirme | ❌ | ❌ | ❌ | ✅ (yalnızca yerel) |

### 6.3 Relay organizasyon rolleri

| Rol | Yetkiler |
|---|---|
| `owner` | Organizasyon ayarları, yönetici atama |
| `admin` | Kullanıcı daveti ve devre dışı bırakma, cihaz kaydını relay'den kaldırma |
| `member` | Kendi cihazlarını kaydetme ve kullanma |

Not: Relay'den cihaz kaydını kaldırmak, o cihazın relay'e bağlanmasını engeller. Ancak eşleştirme yalnızca cihazlardan kaldırılabilir.

## 7. Bilgisayar Kontrolü ve Dosya Erişim İzinleri

### 7.1 Yetenek (capability) modeli

Ajanın her yeteneği ayrı bir anahtarla açılıp kapanır. Varsayılan olarak **hepsi kapalıdır**.

| Yetenek | Faz | Varsayılan | Açma yolu |
|---|---|---|---|
| `files` | 1 | Kapalı (klasör izni yok) | Yerel UI'da klasör ekleme |
| `reports` | 1 | Açık, yalnızca `SAKLAZ Çıktılar` klasörüne | — |
| `apps` (program açma) | 3 | Kapalı | Yerel UI'da uygulama allowlist'i |
| `screen` (ekran görüntüsü ve yardım) | 3 | Kapalı | Yerel UI + her oturumda görünür gösterge |
| `input` (fare ve klavye kontrolü) | 3 | Kapalı | Yerel UI + oturum başına onay + görünür gösterge + acil durdurma kısayolu |
| `browser` | 3 | Kapalı | Yerel UI + site allowlist'i |
| `erp` | 2 | Kapalı | Yerel UI + connector yapılandırması |
| `email` | 3 | Kapalı | Yerel UI |

Faz 1'de yetenek çerçevesi, izin depolama, UI ve politika motoru entegrasyonu **tamamen kodlanır**. Ancak yalnızca `files` ve `reports` yeteneklerinin araçları bulunur. Sonraki fazlar araç eklediğinde güvenlik modeli değişmez.

### 7.2 Klasör izinleri

```ts
interface FolderGrant {
  id: string;
  path: string;                 // realpath ile normalize edilmiş, yerel sürücü
  access: "read" | "read_write";
  recursive: boolean;
  fileTypes?: string[];         // ör. [".xlsx", ".pdf"]; boşsa hepsi
  expiresAt?: string;           // süreli izin seçeneği
  grantedBy: "local" | `phone:${string}`;
}
```

**Yol doğrulama kuralları** (her erişimde ve her adımda uygulanır):

- Yol `realpath` ile normalize edilir. Sonuç bir grant'in altında değilse erişim reddedilir.
- Sembolik link ve junction ile grant dışına çıkılırsa erişim reddedilir.
- UNC yolları, `\\?\` önekleri, ADS (`dosya:akış`), 8.3 kısa adlar ve sondaki nokta/boşluk hileleri reddedilir.
- Yasaklı kökler hiçbir koşulda grant'e eklenemez:
  - `%WINDIR%`, `%PROGRAMFILES%`, `%APPDATA%`, `%LOCALAPPDATA%`
  - Tarayıcı profilleri, `.ssh`, `.gnupg`
  - SAKLAZ'ın kendi veri klasörü
- **TOCTOU koruması:** Dosya açıldıktan sonra açılan tanıtıcının (handle) gerçek yolu tekrar kontrol edilir. Böylece kontrol ile kullanım arasında yolun değiştirilmesi engellenir.

**Yazma kuralları:**

- Yalnızca `read_write` grant'ler ve çıktı klasörü yazılabilir.
- Var olan bir dosyanın üzerine yazmak `critical` sayılır.
- Silme işlemi dosyayı yalnızca Geri Dönüşüm Kutusu'na taşır ve `critical` sayılır.

### 7.3 İzin değişiklikleri

- Varsayılan olarak izinler **yalnızca masaüstünden**, yerel kullanıcı ve Windows Hello onayıyla değiştirilir.
- Organizasyon politikası izin verirse `owner` rolündeki telefon `grant.request` gönderebilir. Bu, `critical` bir işlemdir; onay ekranında tam yol ve erişim türü gösterilir.
- Tüm izin değişiklikleri denetim kaydına yazılır. Masaüstünde "Aktif izinler" ekranı her zaman görünürdür.

## 8. İnternet Kesintisinde Görev Yönetimi

### 8.1 Senaryolar

| Durum | Davranış |
|---|---|
| **Windows çevrimdışı**, telefon çevrimiçi | Komut relay kuyruğunda bekler (TTL: komutun `expiresAt` değeri, varsayılan 24 saat). Telefonda "Bilgisayar çevrimdışı — bağlanınca çalışacak" gösterilir. Süre dolarsa görev `expired` olur ve hiç çalışmaz. |
| **Telefon çevrimdışı**, Windows çevrimiçi | Ajan görevi çalıştırır. Sonuçlar outbox'ta bekler. Onay gereken adımda görev `awaiting_approval` durumunda bekler; onay süresi dolarsa adım **çalışmaz** ve görev `approval_expired` olur. |
| **Relay erişilemez** | Ajan yerel olarak tam çalışır: masaüstü UI, kural motoru, yerel model ve yerel onay (Windows Hello). Uzaktan komut alınamaz. Bağlantı denemeleri üstel geri çekilme ve rastgele sapma (jitter) ile yapılır: 1 sn → 5 dk. |
| **Ajan bir görevin ortasında kapandı veya çöktü** | Yeniden başlarken `running` durumundaki görevler `interrupted` olarak işaretlenir. `read` adımları idempotent olduğu için güvenle yeniden denenebilir. `write` ve `critical` adımlar **otomatik olarak tekrarlanmaz**; kullanıcıya "kesintiye uğradı, tekrar çalıştırılsın mı?" diye sorulur. |
| **Relay kesinti sırasında yeniden başladı** | Teslim edilmemiş zarflar relay veritabanında kalıcıdır ve kaybolmaz. |

### 8.2 Teslim garantisi

Teslim üç seviyede onaylanır:

1. **Relay onayı:** Zarf relay'de kalıcı olarak saklandı.
2. **Cihaz onayı:** Zarf alıcı cihaza teslim edildi; relay zarfı siler.
3. **Uçtan uca onay:** Alıcı, imzalı `ack` mesajıyla zarfı doğrulayıp kaydettiğini bildirir. Bu onay gelene kadar gönderen, mesajı kendi outbox'ında tutar.

Gönderen, uçtan uca onay gelmezse aynı `msgId` ile yeniden gönderir. Alıcı `msgId` ve sayaç sayesinde tekrarları **bir kez** işler. Sonuç olarak "tam olarak bir kez işleme" (exactly-once) davranışı uygulama düzeyinde sağlanır.

### 8.3 Onaylar ve saat farkı

- Onay isteğinde ajanın ürettiği rastgele bir `challenge` bulunur. Telefonun imzası bu değeri kapsar.
- Onayın geçerlilik süresi **ajanın kendi saatiyle**, isteğin gönderildiği andan itibaren ölçülür (varsayılan 10 dk). Telefon saatinin yanlış olması güvenliği etkilemez.
- Bir `challenge` yalnızca bir kez kullanılabilir.

### 8.4 Komut zaman penceresi

- **Çevrimiçi komutlar:** `ts` ±5 dk içinde olmalıdır.
- **Kuyruktan gelen komutlar:** `ts` en fazla `expiresAt` kadar eski olabilir. Ancak `expiresAt` en fazla 72 saat olabilir.
- **Asıl replay koruması** sayaç ve nonce ile sağlanır. Zaman damgası yalnızca ek bir katmandır.

### 8.5 Senkronizasyon

- Görev geçmişinin asıl kaydı ajandadır. Telefon yeniden bağlandığında `history.query {sinceCtr}` göndererek eksik olayları çeker.
- Telefondaki yerel geçmiş bir önbellektir. Telefon silinirse geçmiş ajandan yeniden yüklenir.

## 9. Merkezi Sunucu (Relay) Güvenliği

### 9.1 Ağ yerleşimi

```
İnternet ──443──► [Şirket güvenlik duvarı] ──443──► DMZ: relay-VM
                                                      ├── Caddy (TLS 1.3, ters proxy) :443
                                                      ├── relay (Node)  :8080  ← yalnızca Docker iç ağı
                                                      └── PostgreSQL    :5432  ← yalnızca Docker iç ağı
Yönetim VLAN'ı ──22 (yalnızca anahtar ile)──► relay-VM
relay-VM ──► İnternet: yalnızca FCM, OS güncellemeleri, ACME
relay-VM ──X──► Şirket iç ağı (ERP, dosya sunucuları): ERİŞİM YOK
```

- **Önemli:** Relay VM'den şirket iç ağına erişim **güvenlik duvarında kapatılır**. Relay ele geçirilse bile iç ağa sıçrama noktası olamaz.
- Windows ajanları relay'e **giden** 443 bağlantısı kurar (D2). Ajanlara gelen kural yoktur.

### 9.2 İşletim sistemi sıkılaştırma

| Konu | Uygulama |
|---|---|
| İşletim sistemi | Ubuntu 24.04 LTS, minimal kurulum. CIS Benchmark Seviye 1 baz alınır. |
| Güncellemeler | Güvenlik güncellemeleri otomatik (`unattended-upgrades`); çekirdek güncellemeleri bakım penceresinde. |
| SSH | Yalnızca anahtar ile giriş. `PermitRootLogin no`. Yalnızca yönetim VLAN'ından erişim. fail2ban etkin. |
| Güvenlik duvarı | nftables, varsayılan olarak reddet. Gelen trafik: 443 (her yerden), 22 (yalnızca yönetim VLAN'ı). |
| Disk | Disk şifreleme (LUKS veya hipervizör düzeyinde). |
| Zaman | NTP senkronizasyonu (denetim kayıtlarının doğruluğu için). |

### 9.3 Konteyner güvenliği

- Konteynerler root olmayan kullanıcıyla ve salt okunur kök dosya sistemiyle çalışır. `cap_drop: ALL` ve `no-new-privileges` ayarlanır.
- İmajlar sürüm ve özetle (digest) sabitlenir. CI'da Trivy ile güvenlik açığı taraması yapılır.
- Gizli bilgiler Docker secrets ile dosya olarak verilir. Ortam değişkenlerinde gizli bilgi tutulmaz.

### 9.4 Uygulama katmanı

| Kontrol | Uygulama |
|---|---|
| TLS | Yalnızca TLS 1.3. HSTS (preload). OCSP stapling. |
| HTTP başlıkları | `X-Content-Type-Options`, `Referrer-Policy`. Yalnızca API olduğu için tarayıcı içeriği sunulmaz. |
| Hız sınırı | IP başına ve hesap başına sınır. Girişlerde ilerleyen gecikme. Cihaz başına mesaj ve bant genişliği kotası. |
| Boyut sınırları | WSS mesajı ≤ 256 KB. Dosya parçası ≤ 64 KB. Cihaz başına kuyruk ≤ 500 MB. |
| Girdi doğrulama | Tüm uç noktalarda zod şeması. Bilinmeyen alanlar reddedilir. |
| Kimlik doğrulama | WSS bağlantısında JWT ile birlikte cihaz anahtarıyla nonce imzası gerekir. Çalınmış bir JWT, cihaz anahtarı olmadan işe yaramaz. |
| Saldırı tespiti (opsiyonel) | Ters proxy önünde CrowdSec kullanılabilir. Şirkette mevcut bir WAF veya IPS varsa o tercih edilir. |
| Loglama | Yapısal loglar (içerik içermez) şirketin SIEM sistemine veya syslog'a gönderilir. |

### 9.5 Ele geçirilme durumunda

- **Tasarım gereği etki:** Sınırlıdır; meta veri sızar ve hizmet kesintisi yaşanır (SECURITY.md §3.1). Faz 1'de bu durum otomatik bir testle doğrulanır (S16).
- **Olay müdahale adımları:**
  1. VM izole edilir.
  2. Disk imajı alınır.
  3. Relay temiz bir imajdan yeniden kurulur.
  4. JWT ve MFA anahtarları döndürülür.
  5. Kullanıcılara parola sıfırlama zorunluluğu getirilir.
  6. Cihaz eşleştirmeleri **değişmez**, çünkü güven kökü cihazlardadır.

## 10. Test Stratejisi

### 10.1 Test katmanları

| Katman | Araç | Kapsam |
|---|---|---|
| Birim | Vitest, flutter_test | Tüm paketler. Çekirdek mantıkta ≥ %80, `crypto` ve `policy` paketlerinde ≥ %95 kapsam. |
| Özellik tabanlı (property-based) | fast-check | Kanonik JSON, yol normalizasyonu, zarf ayrıştırıcı, sayaç ve replay mantığı. |
| Fuzz | Jazzer.js veya fast-check tabanlı fuzz | Dış zarf ayrıştırıcı, iç mesaj ayrıştırıcı, dosya ayrıştırıcı worker'lar. |
| Kripto uyumluluk | Ortak JSON test vektörleri | Aynı vektörler TS ve Dart tarafında CI'da çalışır: imza, Noise el sıkışması, mühürlü zarf, dosya parçası, SAS. |
| Entegrasyon | Vitest + Docker Compose | Relay + PostgreSQL + gerçek ajan çekirdeği + simüle edilmiş telefon istemcisi (TS). |
| Güvenlik senaryoları | Özel test düzeneği | S1–S16. Özellikle "ele geçirilmiş relay" düzeneği: relay kodunun yerine saldırgan sürümü konur ve sahte komut, sahte onay, tekrar oynatma, sıra değiştirme, sahte anahtar ve düşürme senaryoları denenir. Hepsinin reddedildiği doğrulanır. |
| Uçtan uca | Playwright (Electron) + Flutter integration_test (emülatör) | ROADMAP'teki 6 çıkış senaryosu. |
| Windows | GitHub Actions `windows-latest` çalıştırıcısı | Ajan testleri gerçek Windows'ta çalışır: yol hileleri, DPAPI, named pipe ACL ve Geri Dönüşüm Kutusu. |
| Performans | k6 (relay), özel ölçüm betikleri (ajan) | REQUIREMENTS N-10 … N-13 ölçülür. |

### 10.2 CI kapıları

Bir değişikliğin birleştirilebilmesi için hepsinin geçmesi zorunludur:

- lint
- typecheck
- birim testler
- kripto test vektörleri
- güvenlik senaryoları
- gitleaks
- CodeQL
- Trivy
- bağımlılık lisans kontrolü

### 10.3 Bitti tanımı (Definition of Done)

Bir maddenin ROADMAP'te ✅ olabilmesi için:

1. Kodu gözden geçirilmiş olmalı.
2. Testleri CI'da geçmeli.
3. İlgili güvenlik kontrolü (S-numarası) testle bağlanmış olmalı.
4. Dokümantasyonu güncellenmiş olmalı.
5. Gerçek cihazda gösterilmiş olmalı (demo).

### 10.4 Test verisi (D5)

- Yalnızca **sentetik** veri kullanılır. `fixtures/` altında betikle üretilen Excel, PDF ve Word dosyaları bulunur: hayali tedarikçi adları, rastgele tutarlar.
- Her sentetik dosya, adında ve meta verisinde `SAKLAZ-TEST` etiketi taşır.
- Gerçek şirket dosyası veya ASEDEN verisi repoya, test düzeneklerine ve CI'a **girmez**. Bu kural bir pre-commit kontrolü ile desteklenir (dosya adı, meta veri ve boyut sezgileri).
- Mock ERP verisi Faz 1'de yoktur; ERP Faz 2'dedir. Faz 2'de geldiğinde her kayıt `source: "mock"` taşır.

### 10.5 Gerçek cihaz test matrisi

| Platform | Minimum |
|---|---|
| Windows | Bir Windows 10 22H2 ve bir Windows 11 bilgisayar. Biri şirket alan adına (domain) bağlı ve şirketin EDR yazılımı kurulu olmalı. |
| Android | Bir orta segment Android 12+ cihaz ve bir StrongBox destekli cihaz. |

### 10.6 Windows envanter betiğinin doğrulanması (D6)

1. **Otomatik doğrulama (Sprint 1):** Betik için Pester testleri yazılır ve GitHub Actions `windows-latest` çalıştırıcısında çalıştırılır. Bu test, betiğin hatasız çalıştığını, geçerli JSON ürettiğini ve **hiçbir kayıt defteri veya dosya değişikliği yapmadığını** doğrular. Doğrulama, çalıştırma öncesi ve sonrası anlık görüntü karşılaştırmasıyla yapılır.
2. **Gerçek ortam doğrulaması:** IT gözetiminde, şirketin tipik bir kullanıcı bilgisayarında çalıştırılır. Çıktı incelenir; hatalı veya eksik alanlar düzeltilir.
3. Betik, ancak bu iki adımdan sonra ROADMAP'te ✅ olarak işaretlenir.

## 11. Yedekleme ve Kurtarma Stratejisi

| Veri | Asıl yeri | Yedek | Hedef |
|---|---|---|---|
| Relay DB (hesaplar, cihaz kaydı, meta veri denetim kaydı, kuyruk) | Relay VM | Günlük `pg_dump`, `age` ile şifreli, şirket yedek sunucusuna. 30 gün saklanır. Ayda bir **geri yükleme testi** yapılır. | RPO 24 saat, RTO 4 saat |
| Relay yapılandırması | Git (infra) | Repoda tutulur. Gizli bilgiler ayrı, şifreli. | Yeniden kurulum ≤ 1 saat |
| Ajan yerel DB (görev geçmişi, denetim kaydı, izinler) | Windows | Haftalık **şifreli dışa aktarma**, kullanıcının seçtiği yerel ve ağ konumuna. Anahtar kullanıcı parolasından (Argon2id) türetilir. | Kullanıcı tarafından geri yüklenir |
| Ajan denetim kaydı | Windows | Yukarıdaki yedeğe ek olarak, zincir başının imzalı kopyası telefonda tutulur. Böylece silme veya kurcalama tespit edilebilir. | — |
| Cihaz kimlik anahtarları | Keystore, DPAPI | **Yedeklenmez** (bilinçli tasarım). Kayıp durumunda yeniden eşleştirme yapılır. | — |
| Üretilen raporlar | `SAKLAZ Çıktılar` klasörü | Şirketin mevcut dosya yedekleme politikasına tabidir. | — |
| Yayın imza anahtarı | Çevrimdışı ortam | İki fiziksel kopya, ayrı güvenli konumlarda. | — |

Kurtarma prosedürleri (relay yeniden kurulumu, ajan geri yüklemesi, telefon kaybı) Faz 1'de `docs/runbooks/` altında yazılır ve en az bir kez prova edilir.

## 12. ASEDEN Paralel Hattı (D4, D5)

| İş | Sorumlu | Faz 1 ile ilişkisi |
|---|---|---|
| ASEDEN kaynak koduna salt okunur erişim | Proje sahibi + ASEDEN yöneticisi | Bağımsız |
| Keşif Adım B–D | ASEDEN yöneticisi + IT | Bağımsız |
| Bulgu tablosunun doldurulması ve yöntem seçimi | Ben (bulgular geldikçe) + proje sahibi onayı | Bağımsız |
| `packages/erp-core` arayüzü | — | **Faz 2.** Faz 1'de dokunulmaz. |
| `packages/erp-aseden` | — | Motor doğrulanana kadar boş kalır. |

**Bağımsızlık güvencesi:** MVP'nin bağımlılık grafiğinde ERP paketleri yoktur. CI'da bir kural bunu zorunlu kılar: `apps/*` paketleri `erp-*` paketlerini Faz 2'ye kadar içe aktaramaz.

## 13. İş Planı — v0.3 (6 sprint ≈ 13 hafta)

> 2026-11-12: Proje sahibi, mimari v0.3'ü (A seçeneği) onayladı. Önceki 10 haftalık planın yerini alır.

| Sprint | Süre | Odak | Teslim edilenler | Bitiş ölçütü |
|---|---|---|---|---|
| **S1** ✅* | 2 hf | Temel ve kripto | Monorepo, CI, `crypto` (Noise_KK, mühürlü zarf, SAS), `protocol` (JCS, şemalar, imzalı mesaj, işleme bağlı onay, replay) | *Dart vektörleri ve GitHub CI bekliyor (Sprint 1 raporu) |
| **S2** | **3 hf** | Relay, eşleştirme, cihaz listesi, ajan güvenlik çekirdeği | Protokol: `ws`/`rh` başlığı, `roster.ts` (genesis, ekleme+eş-imza, iptal+anahtar yasağı, telefon–bilgisayar bağları, çatallanma tespiti). Relay: hesap+TOTP, cihaz kimlik doğrulama, şifreli yönlendirme, süreli kuyruk, presence, meta denetim, Docker Compose. Ajan: SQLCipher depolar, hash zincirli denetim, **rollback koruması**, **acil kilit** (kuyruktan ilk iş), iptal, gelen kutusu, transport. Uçtan uca: eşleştirme → liste → imzalı komut → ack. | S2–S5, S17–S21 testleri; "relay'de düz metin yok" testi; gecikme/engelleme senaryoları (S23) raporlanmış |
| **S3** | 2 hf | Ajan çekirdeği ve araçlar | Orkestratör, politika motoru, yetenekler ve klasör izinleri, worker havuzu, Faz 1 araçları, RuleEngine, DataGuard, Excel/Raporlama ve Kişisel Asistan ajanları, DPAPI kasası (Windows CI'da) | Simüle telefondan "Excel özetle" uçtan uca; S6–S11 |
| **S4** | **3 hf** | Android ve masaüstü | Flutter: **PERSONAL/BUSINESS alanları** (ayrı anahtar setleri, ayrı DB, ayrı FCM, renk/isim ayrımı, MDM uyumu), eşleştirme (QR, SAS, attestation), komut, geçmiş, biyometrik onay, push. Electron: Faz 1 ekranları, ACİL DURDUR. | Gerçek telefon + gerçek Windows uçtan uca, iki alan ayrı |
| **S5** | 2 hf | Sağlamlaştırma ve kurulum | Ele geçirilmiş relay düzeneği (S16, S23), fuzz, performans ölçümü, kesinti senaryoları, kod imzalama + imzalı güncelleme doğrulaması (S14), **iki relay kurulumu** (kişisel VPS + şirket DMZ) | Faz 1 çıkış kriterleri (kurtarma hariç) |
| **S6** | 1 hf | Kurtarma | Yedek cihaz akışı, kağıt kurtarma ifadesi, 72 saat zaman kilidi + yerel veto, şifreli veri yedeği, geri yükleme provası; **bağımsız güvenlik testine teslim paketi** | S22 iç testleri; bağımsız test planlanmış |

**Toplam:** ≈ 13 hafta. Kurtarma mekanizması, bağımsız güvenlik testi sonuçlanmadan üretim kullanımına açılmaz (proje sahibi şartı).

**Ara gösterimler:** Her sprint sonunda rapor sunulur. Raporda ayrı başlıklar altında şunlar bulunur:

- Çalışan özellikler
- Testler
- Güvenlik açıkları
- Eksikler
- **Gerçek cihazlarda doğrulanmamış konular**
- Sunucunun mesajları geciktirmesi veya engellemesiyle ilgili gözlemler

Hiçbir raporda çalışmayan bir özellik "tamamlandı" olarak gösterilmez.

## 14. Faz 1 Başlamadan Gereken Hazırlıklar

| # | Hazırlık | Kim | Ne zaman |
|---|---|---|---|
| H1 | GitHub repo erişiminin açılması | Proje sahibi | S1 öncesi |
| H2 | Kod imzalama sertifikası (OV veya EV) siparişi. Teslim haftalar sürebilir. | Proje sahibi | S1 başında |
| H3 | Relay için alan adı (ör. `relay.<şirket>.com.tr`) ve DNS kaydı | Proje sahibi + IT | S4 öncesi |
| H4 | DMZ'de VM tahsisi (2 vCPU, 4 GB, 40 GB) ve güvenlik duvarı kuralları (§9.1) | IT | S4 öncesi |
| H5 | Firebase projesi: yalnızca FCM için ayrı bir proje, ASEDEN'in Firebase projesinden **bağımsız** | Proje sahibi | S4 öncesi |
| H6 | Test cihazları (§10.5) | Proje sahibi | S4 öncesi |
| H7 | Yayın imza anahtarının saklanacağı çevrimdışı ortam kararı | Proje sahibi | S5 öncesi |
| H8 | Envanter betiğinin gerçek bilgisayarda çalıştırılması | IT | S1–S2 |

## 15. Bilinen Sınırlar (Faz 1 sonunda bile)

- iOS desteği yoktur.
- Sesli komut, Outlook, tarayıcı ve ekran kontrolü yoktur.
- Tek telefonla kullanımda, telefon kaybolursa uzaktan erişim yeniden eşleştirmeye kadar durur. Bu bilinçli bir tasarım kararıdır.
- Yerel model kalitesi ve hızı donanıma bağlıdır. Kural motoru her zaman çalışır, ama serbest dildeki komutları anlama yeteneği sınırlıdır.
- Harici güvenlik denetimi Faz 4 öncesindedir. Faz 1 kendi testlerimizle doğrulanır; bağımsız bir denetimin yerini tutmaz.

## 16. Faz 1 Onay Şartları ve Ek Güvenlik İstekleri (proje sahibi, 2026-11-12)

### 16.1 Şartların karşılığı

| # | Şart | Karşılığı | Durum |
|---|---|---|---|
| 1 | Güvenlik mimarisinden taviz yok | ADR 0001–0012; her sapma ADR ile kayda geçer | Sürekli |
| 2 | Her uzaktan komut telefonda imzalı | `IncomingVerifier`: imzasız veya yanlış imzalı mesaj reddedilir | Sprint 1'de protokol düzeyinde testli |
| 3 | Sunucu kendi başına araç veya komut çalıştıramamalı (SECURITY.md §0 varsayımları altında) | Relay'in imza anahtarı yok. Kontrol mesajları ayrı şemada; "ele geçirilmiş relay" testleri yazıldı | Sprint 1'de protokol testli; S16 entegrasyon testi Sprint 5'te |
| 4–5 | ERP ve şirket dosyaları testte kullanılmaz; yalnızca sentetik veri | §10.4. Test verileri `SAKLAZ-TEST` etiketli; CI'da ERP sınır kontrolü var | Sınır kontrolü Sprint 1'de çalışıyor (negatif testli) |
| 6 | ASEDEN MVP dışı | `check-boundaries.mjs`, CI'da zorunlu | Sprint 1'de çalışıyor |
| 7–8 | Sprint sonu test ve rapor; başarısız test gizlenmez | `docs/sprints/SPRINT-n-RAPOR.md`; ✅ yalnızca CI'da geçen testler için kullanılır | Sprint 1 raporu hazır |
| 9 | Yerel git ve yedekleme düzeni | Her anlamlı adımda commit atılır. Proje belgeleri Claude Projesi'ne de kopyalanır | Sürekli |
| 10 | Ajanın yetkileri kullanıcı tarafından sınırlandırılabilir | §7 yetenek modeli: tüm yetenekler varsayılan kapalı, klasör izinleri yerel | Sprint 3 |

### 16.2 İşleme bağlı onay (uygulandı, ADR-0011)

**Onayın kapsamı.** Telefonun imzaladığı özet şunların **tamamını** kapsar:

- araç ve risk
- özet metni
- **tüm hedefler** (dosya, program, alıcı)
- **tüm parametreler**
- görev, adım ve onay kimlikleri
- ajanın tek kullanımlık challenge değeri
- süre

**Değişikliğe karşı koruma.**

- **Telefon tarafı:** Telefon özeti kendisi yeniden hesaplar. Gösterilecek içerik özetle uyuşmuyorsa onay ekranı hiç açılmaz.
- **Ajan tarafı:** Ajan, aracı çalıştırmadan hemen önce özeti gerçek parametrelerden yeniden hesaplar. Tek bir fark varsa çalıştırma reddedilir.

**Telefon arayüzü kuralları** (Sprint 4):

- Özet metninin yanında hedef listesi ve parametreler **her zaman** gösterilir. Özet metni tek başına yeterli sayılmaz.
- "Onayla" düğmesi, hedef listesinin sonuna kadar kaydırılmadan etkinleşmez.
- Yön ve kontrol karakterleri şema düzeyinde reddedilir. Bu sayede `rapor‮gpj.exe` gibi görsel aldatmalar onay ekranına ulaşamaz (testli).

### 16.3 Acil bağlantı kesme ve yetki iptali

| Mekanizma | Nereden | Etki | Plan |
|---|---|---|---|
| **Acil kilit (yerel)** | Windows: masaüstü "ACİL DURDUR" düğmesi, sistem tepsisi ve genel kısayol tuşu | Relay bağlantısı hemen kesilir. Çalışan görevler güvenli bir noktada iptal edilir. Kilit kalıcıdır. **Kilit yalnızca yerelde, Windows Hello veya yönetici PIN'i ile açılır.** | Sprint 2: bağlantı kesme ve kalıcı kilit. Sprint 3: görev iptali. Sprint 4: arayüz ve kısayol. |
| **Acil kilit (uzaktan)** | Telefon: imzalı `agent.lockdown` mesajı (`owner` ve `operator`) | Yerel kilitle aynı. Bilgisayar kapalıysa mesaj kuyrukta bekler (en çok 72 saat) ve bilgisayar açılınca **ilk iş** olarak uygulanır. | Mesaj tipi ve yetkisi Sprint 1'de protokolde. Ajan tarafı Sprint 2'de. |
| **Cihaz iptali (yerel)** | Windows: "Cihazlar → İptal" (Windows Hello) | O telefonun anahtarı hemen ve kalıcı olarak reddedilir. Relay'e de bildirilir, ancak iptalin geçerliliği relay'e bağlı değildir. | Sprint 2 |
| **Cihaz iptali (uzaktan)** | `owner` telefondan imzalı `device.revoke` | Başka bir telefonun yetkisi kaldırılır (`critical`, onay gerektirir) | Sprint 1'de protokolde. Ajan tarafı Sprint 2'de. |
| **Hesap kapatma** | Relay yöneticisi | Hesabın relay'e bağlanması engellenir. Bu ek bir katmandır; asıl güven kökü cihazlardır. | Sprint 2 |

**Önemli:** Relay, acil kilit veya iptal mesajı **uyduramaz** (imza gerekir) ve kilidi **açamaz** (açma işlemi yalnızca yereldir). Relay'in yapabileceği tek kötü şey bu mesajları geciktirmektir. Bu riske karşı yerel kilit her zaman çalışır.

### 16.4 İşlem geçmişi

- **Asıl kayıt** ajandaki hash zincirli denetim kaydıdır (Sprint 2). Bu kayıt şunları içerir: her komut ve imzası, plan, araç çağrıları, onaylar ve retler, reddedilen mesajlar (hata koduyla), acil kilit ve iptaller.
- **Telefona aktarım:** `history.query` ve `history.page` mesajları Sprint 1'de protokolde tanımlandı. Telefon geçmiş ekranı Sprint 4'te yapılacak.
- **Kurcalama tespiti:** Zincir başının imzalı kopyası telefona gönderilir. Bu sayede bilgisayarda kayıt silinirse fark edilir.

### 16.5 Sprint planındaki değişiklikler

| Sprint | Eklenen |
|---|---|
| Sprint 2 | Acil kilit (bağlantı kesme, kalıcı kilit, kuyruktan gelen kilidin ilk iş uygulanması), yerel ve uzaktan cihaz iptali, Dart kripto kütüphanesi kararı (ADR-0008), kod imzalama sağlayıcı kararı |
| Sprint 4 | Onay ekranı kuralları (§16.2), ACİL DURDUR düğmesi ve kısayolu |

## 17. v0.3 Kararları (proje sahibi, 2026-11-12)

| # | Karar |
|---|---|
| D7 | PERSONAL ve BUSINESS alanları ayrı anahtar, ayrı sunucu, ayrı kayıt ve ayrı yetkilerle çalışır. |
| D8 | PERSONAL relay proje sahibinin kontrolündeki küçük bir VPS'te çalışır; BUSINESS relay şirket içi sunucuda kalır. Sağlayıcı ve maliyet ayrıca onaya sunulacak. |
| D9 | Yeni cihaz eklemek için QR eşleştirmesi ve donanım destekli biyometrik anahtar gerekir. Biyometri ham verisi hiçbir sunucuya gönderilmez. |
| D10 | Üç katmanlı kurtarma uygulanır. Yedek cihaz olarak ikinci bir telefon veya tablet kullanılabilir. |
| D11 | Alanlar arası dosya aktarımı Faz 2'dedir; Faz 1'de bu özellik bulunmaz. |
| D12 | Tek Android uygulamasında iki alan bulunabilir. Anahtarlar, oturumlar, bildirim içerikleri ve veriler ayrıdır. Şirket politikaları varsa MDM gereksinimleri uygulanır. |
| D13 | Ek şartlar: rollback koruması; iptal edilmiş anahtarların yeniden kullanılamaması; cihazlar arası güven ilişkilerinin ayrı yönetilmesi; sunucu gecikmesi ve engellemesinin raporlanması; imzalı ve doğrulanmış güncellemeler; kurtarma mekanizmasının bağımsız güvenlik testi; güvenlik iddialarının koşullu dille yazılması. |
