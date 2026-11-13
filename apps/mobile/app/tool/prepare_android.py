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

# Android Gradle eklentisi: şablondaki 8.1.0, güncel androidx bağımlılıkları (webkit 1.14 ≥ 8.1.1) için eski.
# Flutter şablonlarında birlikte kullanılan sürüm çifti: AGP 8.7.0 + Gradle 8.10.2.
AGP = "8.7.0"
GRADLE = "8.10.2"
for name in ("settings.gradle", "settings.gradle.kts"):
    f = root / "android" / name
    if f.exists():
        t = re.sub(r'(id\(?\s*"com\.android\.application"\s*\)?\s+version\s+)"[^"]+"', rf'\g<1>"{AGP}"', f.read_text(encoding="utf-8"))
        f.write_text(t, encoding="utf-8")
        print(f"{name}: AGP {AGP}")
w = root / "android/gradle/wrapper/gradle-wrapper.properties"
w.write_text(re.sub(r"gradle-[0-9.]+-(all|bin)\.zip", f"gradle-{GRADLE}-all.zip", w.read_text(encoding="utf-8")), encoding="utf-8")
print(f"Gradle {GRADLE}")
