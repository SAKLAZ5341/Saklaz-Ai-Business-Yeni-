# Dart uyumluluk testi (vector_check)

> **Durum: YAZILDI, HENÜZ ÇALIŞTIRILMADI.** Sprint 1 geliştirme ortamında Dart SDK'sı ve pub.dev
> erişimi engelli olduğu için bu test yerelde koşturulamadı. GitHub Actions'taki `dart-vectors`
> işi ilk kez repo GitHub'a gönderildiğinde çalışacak. Geçene kadar S13 kontrolü ✅ sayılmaz.

Amaç: Android uygulamasının (Flutter/Dart), TypeScript tarafıyla **birebir aynı** kanonik JSON'u
ve imzaları ürettiğini kanıtlamak. Kaynak: `packages/protocol/test-vectors/saklaz-v1.json`.

Kapsam: JCS, Ed25519 (alan ayrımlı), BLAKE2b, etiketli özet, X25519, imzalı komut, işleme bağlı onay.
Kapsam dışı (Sprint 2'de eklenecek): HKDF, mühürlü zarf, SAS ve Noise_KK; bunlar için Dart kripto
kütüphanesi kararı ADR-0008'de beklemede.

Çalıştırma:

```
cd apps/mobile/vector_check
dart pub get
dart test
```
