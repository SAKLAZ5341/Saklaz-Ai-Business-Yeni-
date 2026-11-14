"""`flutter create --platforms android .` sonrası Android yapılandırmasını düzenler (CI ve yerel derleme).

    python3 tool/prepare_android.py <kök> [--lan-test]

- INTERNET izni (ana manifestte yok; relay ve AI için gerekli)
- Uygulama adı: SAKLAZ AI
- Açık metin trafik: ÜRETİM yapısında KAPALI (usesCleartextTraffic=false + network_security_config
  cleartextTrafficPermitted=false). Yalnızca --lan-test ile (yerel ağ TEST yapısı; uygulama da
  --dart-define=SAKLAZ_LAN_TEST=true ile derlenir) açılır; o yapıda bile kabuk açık metni yalnızca özel
  ağ / loopback adreslere izin verir (lib/net_policy.dart).
- Kullanıcı tarafından eklenen CA sertifikalarına güvenilmez (yalnızca sistem CA'ları).
"""
import pathlib
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
lan_test = "--lan-test" in sys.argv[1:]
root = pathlib.Path(args[0] if args else ".")

m = root / "android/app/src/main/AndroidManifest.xml"
s = m.read_text(encoding="utf-8")
if "android.permission.INTERNET" not in s:
    s = s.replace("<application", '<uses-permission android:name="android.permission.INTERNET"/>\n    <application', 1)
s = re.sub(r'android:label="[^"]*"', 'android:label="SAKLAZ AI"', s, count=1)
s = re.sub(r'\s*android:usesCleartextTraffic="[^"]*"', "", s)
s = re.sub(r'\s*android:networkSecurityConfig="[^"]*"', "", s)
cleartext = "true" if lan_test else "false"
s = s.replace(
    "<application",
    f'<application\n        android:usesCleartextTraffic="{cleartext}"\n        android:networkSecurityConfig="@xml/network_security_config"',
    1,
)
m.write_text(s, encoding="utf-8")

xml_dir = root / "android/app/src/main/res/xml"
xml_dir.mkdir(parents=True, exist_ok=True)
(xml_dir / "network_security_config.xml").write_text(
    f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Üretilmiş dosya (tool/prepare_android.py). {"YEREL AĞ TEST YAPISI" if lan_test else "ÜRETİM YAPISI"} -->
<network-security-config>
    <base-config cleartextTrafficPermitted="{cleartext}">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
""",
    encoding="utf-8",
)
print(f"AndroidManifest.xml hazır — {'YEREL AĞ TEST' if lan_test else 'ÜRETİM'} yapısı, açık metin: {cleartext}")

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
