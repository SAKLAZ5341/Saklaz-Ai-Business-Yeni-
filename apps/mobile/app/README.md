# SAKLAZ AI — Android uygulaması (MVP alfa)

Flutter kabuğu + WebView arayüzü. Arayüz ve protokol/kriptografi `apps/mobile/web`'dedir (TypeScript,
ajan ve relay ile aynı `@saklaz/client-core` / `@saklaz/crypto` kodu). Kabuk; güvenli depolama (Android
Keystore), HTTP ve QR okuma sağlar.

`android/` klasörü depoda tutulmaz; derlemede `flutter create` ile üretilir ve `tool/prepare_android.py`
ile düzenlenir. APK, GitHub Actions'taki **Android APK (MVP alfa)** işinde derlenir ve iş çıktısı
(artifact) olarak indirilir.

Yerel derleme (Flutter 3.27.4, JDK 17):

```sh
pnpm --filter @saklaz/mobile-web run build
cp apps/mobile/web/dist/index.html apps/mobile/app/assets/web/index.html
cd apps/mobile/app
flutter create --org com.saklaz --project-name saklaz_ai --platforms android .
python3 tool/prepare_android.py .
flutter build apk --release
```
