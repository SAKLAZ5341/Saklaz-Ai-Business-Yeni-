# SAKLAZ AI — Risk Kaydı

> **Sürüm:** v0.1 (Faz 0), 2026-11-12
> **Olasılık ve Etki:** D = Düşük · O = Orta · Y = Yüksek

| # | Risk | Olasılık | Etki | Önlem | Sahibi | Durum |
|---|---|---|---|---|---|---|
| R1 | ASEDEN'in gerçek veritabanı beyan edilenden farklı çıkabilir: geçiş tamamlanmamış olabilir, çift yazma yapılıyor olabilir veya Firestore hâlâ kullanılıyor olabilir. | O | Y | Keşif Adım A–D tamamlanmadan connector yazılmaz. Firestore kullanım ölçümleri incelenir. | Proje sahibi + ASEDEN yöneticisi | Açık |
| R2 | ASEDEN'de salt okunur rol veya görünüm için onay çıkmayabilir. | O | O | Yedek plan olarak rapor dışa aktarma ve izinli klasör yöntemi (Seçenek 5) kullanılır. Faz 2 bundan bağımsız başlayabilir. | Proje sahibi | Açık |
| R3 | Connector sorguları canlı ERP'ye yük bindirebilir. | D | O | `statement_timeout`, satır limiti ve önbellek uygulanır. Uzun vadede okuma replikası kullanılır. | Geliştirme | Planlandı |
| R4 | Kurumsal EDR veya antivirüs, ajanı veya Electron uygulamasını engelleyebilir. | O | Y | Kod imzalama sertifikası alınır. IT ile beyaz liste süreci yürütülür. Windows envanteri çıkarılır. | Proje sahibi + IT | Açık |
| R5 | Kod imzalama sertifikası (OV veya EV) temin süresi uzun olabilir. | O | O | Sertifika Faz 1 başında sipariş edilir. Geliştirme sırasında yerel test imzası kullanılır. | Proje sahibi | Açık |
| R6 | Kripto protokol uygulamasında hata olabilir. | D | Y | Kripto kodu kendimiz yazılmaz; libsodium kullanılır. Noise çerçevesi, çapraz platform test vektörleri ve harici kripto incelemesi (Faz 4 öncesi) ile desteklenir. | Geliştirme | Planlandı |
| R7 | Dart (Flutter) ve TypeScript kripto uygulamaları arasında uyumsuzluk olabilir. | O | Y | Ortak test vektörleri hazırlanır ve CI'da her iki platformda çalıştırılır (S13). | Geliştirme | Planlandı |
| R8 | Push bildirim için FCM, bir Google servisidir. İçerik taşımasa da politika açısından itiraz edilebilir. | O | D | Yalnız içeriksiz sinyal gönderilir. Alternatif olarak self-hosted UnifiedPush/ntfy kullanılabilir. | Proje sahibi | Karar bekliyor |
| R9 | Relay için internete port açılmasına IT onay vermeyebilir. | O | O | Seçenek B (WireGuard VPN) veya Seçenek C (şirket VPS'i) kullanılabilir. | Proje sahibi + IT | Karar bekliyor |
| R10 | Prompt injection yoluyla zararlı işlem yaptırılmaya çalışılabilir. | O | Y | Araç çağrısı politika motorundan geçer. Kritik işlemlerde insan onayı alınır. Onay ekranı gerçek parametreleri gösterir. Regresyon test paketi CI'da çalışır. | Geliştirme | Planlandı |
| R11 | Yerel modeller şirket bilgisayarlarında yavaş kalabilir. | Y | O | Kural tabanlı akışlar birinci sınıf tutulur. AI bir hızlandırıcıdır, zorunlu değildir. Gerekirse şirket içinde ayrı bir GPU sunucusunda yerel model barındırılır. | Proje sahibi | Açık |
| R12 | Kapsam genişlemesi, 7 ajan ve çok platform nedeniyle gecikmeye yol açabilir. | Y | O | Faz kapıları uygulanır ve her faz öncesinde onay alınır. MVP yalnızca 2 ajanla sınırlıdır. | Proje sahibi | Kontrol altında |
| R13 | Telefon kaybolabilir ve tek onay cihazı kaybedilebilir. | O | O | Windows'ta yerel kurtarma ve yeniden eşleştirme yapılır. İkinci telefon eklenmesi önerilir. | Kullanıcı | Planlandı |
| R14 | Tek geliştirici bağımlılığı (bus factor) oluşabilir. | O | Y | ADR'ler, dokümantasyon ve testlerle bilgi yazılı tutulur. | Proje sahibi | Açık |
| R15 | Müşteri sözleşmeleri (ör. savunma sanayii) veri işleme ve yerleşim konusunda ek şartlar içerebilir. | O | Y | Varsayılan mimari, veriyi cihazda tutar. Barındırma kararı öncesinde sözleşmeler gözden geçirilir. | Proje sahibi | Açık |
| R16 | GitHub reposuna erişim şu anda kurulamıyor. | — | D | Erişim verilene kadar dokümanlar Proje'de ve yerel git deposunda tutulur. | Proje sahibi | Açık |
