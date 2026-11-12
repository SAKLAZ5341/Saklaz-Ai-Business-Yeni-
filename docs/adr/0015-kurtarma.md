# ADR-0015: Üç katmanlı kurtarma

- **Durum:** Kabul edildi (proje sahibi, 2026-11-12). Sprint 6'da uygulanacak; üretim kullanımından önce **bağımsız güvenlik testi şarttır.**
- **Ayrıntı:** SECURITY.md §19

## Karar
Kurtarma üç katmandan oluşur:
1. **Yedek sahip cihaz:** ikinci bir telefon veya tablet.
2. **Kağıt kurtarma ifadesi:** 24 kelimeden oluşur ve kurtarma anahtarı bu ifadeden türetilir. Anahtarın açık kısmı listenin `genesis` girişinde yer alır. Kullanımında 72 saatlik zaman kilidi ve veto hakkı vardır.
3. **Yerel kurtarma:** Windows Hello ile.

Zaman kilidi, isteğin her bilgisayarda **yerel olarak ilk görüldüğü andan** başlar. Bu yüzden geriye tarihlenmiş bir istek beklemeyi atlatamaz.
Yeni katılan bir cihaz, eşleştirmede gösterilen ve sahip tarafından imzalanmış liste başına sabitlenir. Bu sayede geçmişteki kurtarmalar yeniden zaman kilidine takılmaz.

## Kalan risk
Kurtarma ifadesi çalınır ve aynı anda sunucu veto mesajlarını engellerse risk oluşur. Yerel veto ve ekran uyarısı bu riski azaltır, ancak tamamen ortadan kaldırmaz.
