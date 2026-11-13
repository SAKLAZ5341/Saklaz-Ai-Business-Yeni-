"""`flutter create --platforms android .` sonrası Android yapılandırmasını düzenler (CI ve yerel derleme).

- INTERNET izni (ana manifestte yok; relay ve AI için gerekli)
- Uygulama adı: SAKLAZ AI
- usesCleartextTraffic: yalnızca kullanıcı "yerel ağ testi" seçtiğinde ws:// / http:// kullanılır; arayüz
  bunu açıkça uyarır. Üretim sürümünde kapatılmalıdır (bkz. docs/mvp/BILINEN-EKSIKLER.md).
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
m = root / "android/app/src/main/AndroidManifest.xml"
s = m.read_text(encoding="utf-8")
if "android.permission.INTERNET" not in s:
    s = s.replace("<application", '<uses-permission android:name="android.permission.INTERNET"/>\n    <application', 1)
s = re.sub(r'android:label="[^"]*"', 'android:label="SAKLAZ AI"', s, count=1)
if "usesCleartextTraffic" not in s:
    s = s.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)
m.write_text(s, encoding="utf-8")
print("AndroidManifest.xml hazır")
