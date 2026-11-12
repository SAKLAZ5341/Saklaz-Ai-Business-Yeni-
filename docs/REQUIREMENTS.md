# SAKLAZ AI — Teknik Gereksinimler

> **Sürüm:** v0.1 (Faz 0), 2026-11-12
> **Kapsam:** MVP (Faz 1) ve sonrası.
>
> **Öncelik:** **Z** = Zorunlu (MVP) · **S** = Sonraki faz · **O** = Opsiyonel
>
> **Doğrulama:** **T** = Otomatik test · **İ** = İnceleme · **G** = Gösterim (demo)

## 1. Fonksiyonel Gereksinimler

### 1.1 Eşleştirme ve Cihazlar

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-01 | Kullanıcı bir Android telefonu QR + SAS ile Windows ajanına eşleştirebilir. | Z | T, G |
| F-02 | Eşleştirme, relay sunucusu ortadaki adam (MITM) olsa bile güvenli kalır. | Z | T |
| F-03 | Kullanıcı eşleştirmeyi Windows'tan yerel olarak iptal edebilir; iptal anında geçerli olur. | Z | T |
| F-04 | Telefon, eşleştirilmiş Windows cihazlarının çevrimiçi/çevrimdışı durumunu görür. | Z | T, G |
| F-05 | Bir ajana birden fazla telefon eşleştirilebilir. | S | T |

### 1.2 Görevler

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-10 | Telefondan yazılı komut gönderilir. | Z | T, G |
| F-11 | Telefondan sesli komut gönderilir. Ses tanıma cihaz üzerinde yapılır. | S | G |
| F-12 | Görevlerin durumu canlı izlenir: gönderildi, çalışıyor, onay bekliyor, tamamlandı, hata. | Z | T |
| F-13 | Görev geçmişi telefonda ve masaüstünde görüntülenir. | Z | G |
| F-14 | Windows çevrimdışıyken gönderilen görev kuyrukta bekler ve süresi (varsayılan 24 saat) dolarsa telefonda "süresi doldu" olarak gösterilir. | Z | T |
| F-15 | Masaüstü sohbet ekranından da görev verilir. | Z | G |

### 1.3 Dosya ve Rapor

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-20 | Ajan yalnızca izin verilmiş klasörleri listeler ve arar. | Z | T |
| F-21 | Ajan .xlsx/.xls/.csv dosyalarını okur ve analiz eder: toplam, gruplama, filtre, karşılaştırma. | Z | T |
| F-22 | Ajan PDF (metin katmanlı) ve .docx dosyalarını okur. | Z | T |
| F-23 | Ajan Excel, Word ve PDF formatında rapor üretir. | Z | T, G |
| F-24 | Telefon rapor özetini görür; tam dosyayı açık talep ile indirir. | Z | T, G |
| F-25 | Taranmış PDF'ler için OCR, yerelde çalışır. | S | T |

### 1.4 Onay

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-30 | Her `critical` işlem, telefonda biyometrik doğrulamalı ve imzalı onay olmadan çalışmaz. | Z | T |
| F-31 | Onay ekranı, işlemin gerçek parametrelerini gösterir: tam yollar, alıcılar, tutarlar, kayıt sayısı. | Z | T, İ |
| F-32 | Masaüstünde Windows Hello ile yerel onay verilebilir. | Z | G |
| F-33 | Belirli işlemlerde iki farklı kişinin onayı (4-göz) zorunlu tutulabilir. | S | T |

### 1.5 Ajanlar ve AI

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-40 | Excel ve Raporlama ajanı çalışır. | Z | T, G |
| F-41 | Kişisel Asistan ajanı temel düzeyde çalışır: dosya bulma, özetleme. | Z | T, G |
| F-42 | AI sağlayıcısı olmadan kural tabanlı komutlar çalışır. | Z | T |
| F-43 | Yerel model (Ollama) isteğe bağlı olarak eklenebilir. | Z | T |
| F-44 | Dış AI sağlayıcısı yalnızca yönetici izniyle ve yalnızca izin verilen veri sınıfları için kullanılır. | Z | T |
| F-45 | Satınalma, AS9100 Kalite ve Yönetim Raporlama ajanları çalışır. | S | T, G |
| F-46 | E-posta ajanı (Outlook) çalışır. **MVP dışıdır.** | S | — |
| F-47 | Bilgisayar Kontrol ajanı çalışır: uygulama açma, tarayıcı, ekran yardımı. | S | — |

### 1.6 ERP

| ID | Gereksinim | Öncelik | Doğrulama |
|---|---|---|---|
| F-50 | `ErpConnector` arayüzü ve mock connector mevcuttur. Mock veri her yerde "DEMO VERİ" olarak etiketlenir. | S | T |
| F-51 | ASEDEN connector salt okunurdur ve keşif bulgularına dayanır. | S | T |
| F-52 | ERP'ye yazma işlemleri ayrı paket, ayrı kimlik ve zorunlu onayla yapılır. | O | T |

## 2. Fonksiyonel Olmayan Gereksinimler

### 2.1 Güvenlik

Ayrıntılar için bkz. SECURITY.md §15.

| ID | Gereksinim | Öncelik |
|---|---|---|
| N-01 | S1–S14 ve S16 kontrollerinin testleri CI'da geçer. | Z |
| N-02 | Ajan hiçbir ağ portu dinlemez. | Z |
| N-03 | Relay üzerinden geçen hiçbir mesajda düz metin içerik bulunmaz. Bu, otomatik test ile doğrulanır. | Z |

### 2.2 Performans

Hedefler; Faz 1'de ölçülecektir.

| ID | Gereksinim |
|---|---|
| N-10 | Telefondan gönderilen komutun ajana ulaşma süresi (iki cihaz da çevrimiçiyken) p95 < 2 sn. |
| N-11 | 10 MB'lık bir Excel dosyasının okunup özetlenmesi (kural tabanlı) < 15 sn. |
| N-12 | Ajanın boşta bellek kullanımı < 250 MB (UI hariç). |
| N-13 | Relay, 50 eşzamanlı cihazda 2 vCPU / 4 GB RAM ile çalışır. |

### 2.3 Dayanıklılık

| ID | Gereksinim |
|---|---|
| N-20 | Bağlantı koparsa ajan üstel geri çekilmeyle yeniden bağlanır. Mesaj kaybı olmaz (outbox). |
| N-21 | Ajan çökerse yarım kalan görevler "kesintiye uğradı" durumuna alınır. `critical` adımlar otomatik olarak **tekrarlanmaz**. |
| N-22 | Relay yeniden başlatıldığında teslim edilmemiş zarflar korunur. |

### 2.4 Uyumluluk

| ID | Gereksinim |
|---|---|
| N-30 | Windows 10 22H2 ve Windows 11 (x64). Kesin minimum sürüm, envanter sonucuna göre belirlenecek. |
| N-31 | Android 10 (API 29) ve üzeri. Biyometrik doğrulama ve Keystore gerektirir. |
| N-32 | Relay için Linux x64 ve Docker. |
| N-33 | Arayüz dili Türkçedir. Çok dillilik için altyapı hazır tutulur. |

### 2.5 Kalite

| ID | Gereksinim |
|---|---|
| N-40 | TypeScript strict modda derlenir. `any` kullanımı yasaktır (lint kuralı). |
| N-41 | Paketlerin çekirdek mantığında birim test kapsamı ≥ %80. Kripto ve politika paketlerinde ≥ %95. |
| N-42 | Her uçtan uca senaryo (ROADMAP Faz 1 çıkış kriterleri) otomatik testle doğrulanır. |
| N-43 | Çalışmayan veya testi olmayan hiçbir özellik "tamamlandı" olarak işaretlenmez. |

### 2.6 Gözlemlenebilirlik

| ID | Gereksinim |
|---|---|
| N-50 | Yapısal loglar (pino) kullanılır. Loglarda içerik yoktur, gizli bilgiler maskelenir. |
| N-51 | Ajan, telefona ve masaüstüne sağlık durumunu bildirir: bağlantı, kuyruk, son hata. |

### 2.7 Dağıtım

| ID | Gereksinim |
|---|---|
| N-60 | Relay tek bir `docker compose up` komutuyla kurulur. Kurulum ve yedekleme belgelenir. |
| N-61 | Windows yükleyicisi kod imzalıdır. Güncellemeleri imzalı ve doğrulamalıdır. |
| N-62 | Android uygulaması imzalı APK veya AAB olarak dağıtılır. Dağıtım kanalı (Play Store, MDM veya doğrudan) proje sahibinin kararıdır. |
