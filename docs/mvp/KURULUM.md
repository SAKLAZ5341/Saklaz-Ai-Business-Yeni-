# SAKLAZ AI 0.1.0-alpha — Kurulum ve ilk test

> **Test sürümüdür.** Gerçek şirket verisi veya kritik sistemlerle kullanmayın. Bu sürümde bilgisayarda yalnızca **salt okunur** komutlar çalışır.

## 0. Gerekenler

| Bileşen | Nereden | Not |
|---|---|---|
| Relay sunucusu | `infra/relay` (Docker Compose) | Telefon ve bilgisayarların buluştuğu sunucu. İçerik uçtan uca şifrelidir, relay okuyamaz. |
| Android APK | GitHub → Actions → PR #13'ün son çalışması → **Artifacts** → `saklaz-ai-android-apk` | Android 7+ önerilir. |
| Windows ajan paketi | Aynı yerde → `saklaz-agent-win-x64` | Windows 10/11 x64. Node.js kurmak gerekmez (pakette). |
| Doğrulama uygulaması | Google/Microsoft Authenticator vb. | Hesap girişi parola + 6 haneli kod ister. |

İndirdikten sonra `.sha256` dosyasındaki özeti karşılaştırın:
`certutil -hashfile saklaz-agent-win-x64.zip SHA256` (Windows) / `sha256sum` (Linux).

## 1. Relay

**A) Önerilen — kendi sunucunuz (TLS, alan adı):** [`infra/relay/README.md`](../../infra/relay/README.md) adımları. Sonuç: `wss://relay.alanadiniz.com`.

**B) Yalnızca yerel ağ testi (TLS yok):** Linux veya WSL2 + Docker olan bir makinede:

```sh
docker build -t saklaz-relay:local -f infra/relay/Dockerfile .
sudo infra/relay/scripts/init-secrets.sh /etc/saklaz/lantest
SAKLAZ_RELAY_DOMAIN=lan.invalid SAKLAZ_RELAY_ID=saklaz-lantest SAKLAZ_SECRETS_DIR=/etc/saklaz/lantest \
  docker compose -f infra/relay/docker-compose.yml -f infra/relay/docker-compose.lan-test.yml \
  -p saklaz-lantest up -d --wait relay db
```

Adres: `ws://<makinenin-ip-adresi>:8080`. Telefonda **"Yerel ağ testi"**, Windows'ta `SAKLAZ_ALLOW_INSECURE_RELAY=1` gerekir. Bu kip internete açılmamalıdır. (B seçeneği CI'da sınanmadı.)

Kişisel ve kurumsal alan için **iki ayrı relay** kurulur (ayrı sunucu, ayrı veritabanı, ayrı hesap).

## 2. Telefon

1. APK'yı yükleyin. Bilinmeyen kaynak izni gerekir; APK test anahtarıyla imzalıdır.
2. **Çalışma alanı ekle:**
   1. Alan türünü (Kişisel / Kurumsal), görünen adı ve relay adresini girin.
   2. **Yeni hesap** ile e-posta ve parolayı (en az 12 karakter) girin.
   3. Gösterilen anahtarı doğrulama uygulamasına ekleyin. Anahtar bir daha gösterilmez.
   4. **Giriş** sekmesinde e-posta, parola ve 6 haneli kodu girin.
3. Telefon kendi anahtarlarını üretir. Anahtarlar Android Keystore ile şifrelenmiş depoda kalır.

## 3. Windows bilgisayar (her bilgisayar için)

1. Zip dosyasını açın, örneğin `C:\SAKLAZ\saklaz-agent`. Yolda boşluk olmaması önerilir.
2. Bu klasörde **komut istemi** açın.
3. Kurulum:

   ```bat
   saklaz-agent.cmd setup --profile personal
   ```

   Şunlar sorulur: relay adresi, bilgisayar adı (ör. "Ev bilgisayarı"), e-posta, parola ve doğrulama kodu.

   Not: Aynı 6 haneli kod iki kez kullanılamaz. Telefonda girişten hemen sonraysanız bir sonraki kodu bekleyin.
4. Eşleştirme:

   ```bat
   saklaz-agent.cmd pair --profile personal
   ```

   1. Telefonda **Cihazlar → Bilgisayar ekle** bölümüne gidin.
   2. **QR okut** ile ekrandaki kodu okutun veya alttaki `SAKLAZ1:…` metnini yapıştırın.
   3. **Eşleştir**'e dokunun.
   4. İki ekranda 6 haneli **güvenlik kodu** çıkar. Aynıysa bilgisayarda `e` yazın; farklıysa `h` yazın.
5. Oturum açılışında otomatik başlatma (yönetici yetkisi gerekmez):

   ```bat
   powershell -ExecutionPolicy Bypass -File install-startup.ps1 -AgentProfile personal
   ```

6. Durumu görmek için: `saklaz-agent.cmd status --profile personal`

Kurumsal bilgisayar için aynı adımları `--profile business` / `-AgentProfile business` ve kurumsal relay adresiyle yapın.

## 4. Kullanım

| Ekran | Ne yapılır |
|---|---|
| **Cihazlar** | Bilgisayarlar ve çevrimiçi/çevrimdışı durumu, yeni bilgisayar ekleme |
| **Komut** | Bilgisayar seçimi; `sistem`, `disk`, `ağ`, `işlemler`, `çalışma süresi`, `ping`, `yardım`. Diğer her şey bilgisayarda reddedilir. |
| **AI** | Kişisel asistan / günlük plan / toplantı / satınalma kipleri |
| **Not/Görev** | Bu telefonda, bu alanın şifreli deposunda tutulur |
| **Ayarlar** | Alan değiştirme/ekleme, AI ayarı, acil kilit, bilgisayarı çıkarma |

## 5. Yapay zekâ yapılandırması

| Sağlayıcı | Gereken | Not |
|---|---|---|
| OpenAI | **Ayarlar → Yapay zekâ**: kendi OpenAI API anahtarınız ve model adı (varsayılan `gpt-5.4-mini`) | Hesabınızda erişilebilen bir model adı girin. Anahtar yalnızca telefonda, şifreli depoda tutulur; kaynak koda veya sunucuya gitmez. |
| Yerel | OpenAI uyumlu bir sunucu (ör. Ollama) ve adresi: `http://<pc-ip>:11434/v1` | Veri yerel ağdan çıkmaz. |

- **Kurumsal alanda** bulut AI varsayılan olarak **kapalıdır**; kullanıcı ayarlardan açıkça izin vermelidir.
- AI bilgisayarlara komut gönderemez.
- Anahtar yoksa veya bağlantı kurulamıyorsa sahte yanıt üretilmez; açık bir hata gösterilir.

## 6. Acil durum

| Durum | Ne yapılır |
|---|---|
| Telefon kaybı | Bilgisayarda `saklaz-agent.cmd lockdown --profile <profil>` çalıştırın. Bu profil hiçbir komut kabul etmez. |
| Bilgisayar kaybı | Telefonda **Ayarlar → Bilgisayarı çıkar**. |
| Acil kilit gönderildiyse | Kilit yalnızca bilgisayarda yerel olarak açılabilir (bu sürümde açma arayüzü yok; bkz. bilinen eksikler). |

Ajan verileri `%LOCALAPPDATA%\SAKLAZ\agent-<profil>` altındadır ve DPAPI ile o Windows kullanıcısına bağlıdır. Başka bir Windows kullanıcısı bu verileri çözemez.
