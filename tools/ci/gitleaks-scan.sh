#!/usr/bin/env bash
# SAKLAZ AI — gitleaks tarama sarmalayıcısı (CI: ci.yml "secrets" işi ve gitleaks-full.yml).
#
# Kipler (SCAN_MODE):
#   pr    PR'da yalnızca hedef dal (güncel uç) ile PR kaynak SHA'sı arasındaki commit'ler:
#         refs/remotes/origin/$BASE_REF..$HEAD_SHA
#   push  main'e push: HEAD'den erişilebilen tüm geçmiş (HEAD == $EXPECTED_SHA olmalı).
#   full  Tüm referanslar (--all): dallar, etiketler, refs/remotes/pull/* (PR kaynakları).
#
# Güvenlik kuralları:
#   • Hata olursa GEÇMEZ (fail-closed). gitleaks 8.28.0, git hatasında yalnızca günlüğe yazıp 0 ile
#     çıkar; bu betik git'i önceden aynı seçeneklerle çalıştırır, gitleaks günlüğünde hata satırı
#     arar, rapor dosyasını doğrular ve taranan commit sayısını denetler.
#   • Birleştirme commit'leri --remerge-diff ile taranır: çakışma çözümü ve birleştirmeye gizlice
#     eklenen içerik yakalanır; hedef daldan gelen (orada zaten taranmış) içerik tekrar raporlanmaz.
#   • Satır içi "gitleaks:allow" yok sayılır (--ignore-gitleaks-allow).
#   • .gitleaks.toml kullanımı yasaktır: taranan uçta bulunursa iş başarısız olur. Tarama ayrıca
#     çalışma ağacı olmayan bir --mirror kopya üzerinde ve nötr bir dizinden yapılır; böylece PR'ın
#     getirdiği .gitleaks.toml ve .gitleaksignore hiçbir zaman yüklenmez.
#   • .gitleaksignore yalnızca KORUNAN VARSAYILAN DALDAN okunur ($DEFAULT_BRANCH; ör. main):
#       pr   → refs/remotes/origin/$DEFAULT_BRANCH — PR'ın hedefi başka bir (korumasız) özellik dalı
#              olsa bile o dalın ignore dosyasına GÜVENİLMEZ;
#       push → varsayılan dala push edilen commit (yalnızca varsayılan dalda çalışır);
#       full → $TRUSTED_REF (varsayılan dal; gitleaks-full.yml).
#   • Gizli değerler hiçbir yerde yazılmaz: --redact; özet yalnızca kural, dosya, satır, commit ve
#     parmak izini gösterir (parmak izi gizli değeri içermez).
#
# Çıkış kodları: 0 temiz · 1 bulgu var · 2 tarama/girdi/yapılandırma hatası.
set -Eeuo pipefail
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML

EXPECTED_VERSION="8.28.0"
die() { echo "::error::gitleaks-scan: $*" >&2; exit 2; }
# Zorunlu ortam değişkeni: eksikse çıkış 2 (": ${X:?}" 1 ile çıkar ve "bulgu var" ile karışırdı).
require() { [ -n "${!1:-}" ] || die "$1 gerekli${2:+ ($2)}"; }
trap 'echo "::error::gitleaks-scan: beklenmeyen hata (satır $LINENO)" >&2; exit 2' ERR

require GITLEAKS_BIN
require SCAN_MODE
REPO_DIR="$(cd "${REPO_DIR:-.}" && pwd)"
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:-/tmp}}/gitleaks-scan.$$"

[ -x "$GITLEAKS_BIN" ] || die "gitleaks ikilisi bulunamadı: $GITLEAKS_BIN"
ver="$("$GITLEAKS_BIN" version 2>/dev/null || true)"
[ "$ver" = "$EXPECTED_VERSION" ] || die "gitleaks sürümü '$ver', beklenen '$EXPECTED_VERSION'"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "git deposu değil: $REPO_DIR"

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
has_commit() { git -C "$REPO_DIR" cat-file -e "$1^{commit}" 2>/dev/null; }
has_ref() { git -C "$REPO_DIR" rev-parse --verify -q "$1^{commit}" >/dev/null; }

case "$SCAN_MODE" in
  pr)
    require BASE_REF
    require HEAD_SHA
    require DEFAULT_BRANCH
    git check-ref-format --branch "$BASE_REF" >/dev/null 2>&1 || die "geçersiz hedef dal adı"
    git check-ref-format --branch "$DEFAULT_BRANCH" >/dev/null 2>&1 || die "geçersiz varsayılan dal adı"
    is_sha "$HEAD_SHA" || die "geçersiz HEAD_SHA (40 karakterlik onaltılık SHA bekleniyor)"
    has_commit "$HEAD_SHA" || die "PR kaynak commit'i depoda yok: $HEAD_SHA"
    has_ref "refs/remotes/origin/$BASE_REF" || die "hedef dal referansı yok: refs/remotes/origin/$BASE_REF"
    trusted="refs/remotes/origin/$DEFAULT_BRANCH"
    has_ref "$trusted" || die "varsayılan dal referansı yok: $trusted"
    revs=("refs/remotes/origin/$BASE_REF..$HEAD_SHA")
    policy_tips=("$HEAD_SHA")
    ;;
  push)
    require EXPECTED_SHA
    require DEFAULT_BRANCH
    require PUSH_REF
    [ "$PUSH_REF" = "refs/heads/$DEFAULT_BRANCH" ] || die "push kipi yalnızca varsayılan dalda çalışır ($PUSH_REF)"
    is_sha "$EXPECTED_SHA" || die "geçersiz EXPECTED_SHA"
    head="$(git -C "$REPO_DIR" rev-parse --verify -q 'HEAD^{commit}')" || die "HEAD çözülemedi"
    [ "$head" = "$EXPECTED_SHA" ] || die "HEAD ($head) beklenen commit değil ($EXPECTED_SHA)"
    trusted="$EXPECTED_SHA"
    revs=("$EXPECTED_SHA")
    policy_tips=("$EXPECTED_SHA")
    ;;
  full)
    require TRUSTED_REF
    has_ref "$TRUSTED_REF" || die "güvenilir referans yok: $TRUSTED_REF"
    trusted="$TRUSTED_REF"
    revs=("--all")
    mapfile -t policy_tips < <(git -C "$REPO_DIR" for-each-ref --format='%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)' | sort -u)
    [ "${#policy_tips[@]}" -gt 0 ] || die "taranacak referans yok"
    ;;
  *) die "bilinmeyen SCAN_MODE: $SCAN_MODE" ;;
esac

# .gitleaks.toml yasağı (tarama bunu zaten yüklemez; burada kullanım girişimi açıkça reddedilir).
bad=0
for tip in "${policy_tips[@]}"; do
  if git -C "$REPO_DIR" cat-file -e "$tip:.gitleaks.toml" 2>/dev/null; then
    echo "::error::.gitleaks.toml kullanımı yasak: $(git -C "$REPO_DIR" for-each-ref --points-at "$tip" --format='%(refname)' | tr '\n' ' ')$tip" >&2
    bad=1
  fi
done
[ "$bad" -eq 0 ] || exit 2

# Kapsam ve git ön denetimi: gitleaks'in çalıştıracağı git log aynı seçeneklerle hatasız çalışmalı.
LOG_OPTS=(--remerge-diff --full-history "${revs[@]}")
total="$(git -C "$REPO_DIR" rev-list --count "${revs[@]}")" || die "commit aralığı çözülemedi"
echo "Kapsam ($SCAN_MODE): ${revs[*]} — $total commit"
echo "Güvenilir .gitleaksignore kaynağı: $trusted"

# Çalışma ağacı olmayan kopya + nötr dizin + güvenilir ignore dosyası.
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/neutral" "$WORK_DIR/ignore"
git clone -q --mirror "$REPO_DIR" "$WORK_DIR/scan.git" || die "tarama kopyası oluşturulamadı"
if [ "$SCAN_MODE" = "pr" ]; then
  git -C "$WORK_DIR/scan.git" cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || die "kaynak commit tarama kopyasında yok"
fi
ign="$WORK_DIR/ignore/trusted.gitleaksignore"
if git -C "$REPO_DIR" cat-file -e "$trusted:.gitleaksignore" 2>/dev/null; then
  git -C "$REPO_DIR" show "$trusted:.gitleaksignore" >"$ign"
else
  : >"$ign"
fi
echo "Güvenilir ignore girdisi: $(grep -cvE '^\s*(#|$)' "$ign" || true)"

# Beklenen en az taranacak commit sayısı (kısmi tarama denetimi). gitleaks 8.28.0 bir commit'i, o commit'in
# silinmemiş dosyalarından en az bir parça (hunk) ürettiğinde sayar; silinen ve arşiv olmayan ikili dosyalar
# sayılmaz, arşivler ayrıca sayılabilir. Burada gitleaks'in çalıştıracağı komutun AYNISI, tarama kopyası
# üzerinde çalıştırılır ve en az bir silinmemiş metin parçası içeren commit'ler sayılır → alt sınır.
# (--no-pager yalnızca çağrıyı ayırt etmek içindir; çıktıyı değiştirmez.) git hatası → iş başarısız.
expected="$(set -o pipefail; git --no-pager -C "$WORK_DIR/scan.git" log -p -U0 "${LOG_OPTS[@]}" | python3 -c '
import re, sys
commit = re.compile(rb"^commit ([0-9a-f]{40})")
seen, cur, in_file, deleted, hunk = set(), None, False, False, False
def close_file():
    if cur and in_file and hunk and not deleted:
        seen.add(cur)
for line in sys.stdin.buffer:
    m = commit.match(line)
    if m:
        close_file(); cur, in_file, deleted, hunk = m.group(1), False, False, False
    elif line.startswith(b"diff --git ") or line.startswith(b"diff --cc ") or line.startswith(b"diff --combined "):
        close_file(); in_file, deleted, hunk = True, False, False
    elif in_file and not hunk and line.startswith(b"deleted file mode"):
        deleted = True
    elif in_file and line.startswith(b"@@"):
        hunk = True
close_file()
print(len(seen))
')" || die "beklenen commit sayısı hesaplanamadı (git log başarısız)"
[[ "$expected" =~ ^[0-9]+$ ]] || die "beklenen commit sayısı okunamadı"
echo "Taranması gereken (en az): $expected commit"
[ ! -e "$WORK_DIR/scan.git/.gitleaks.toml" ] && [ ! -e "$WORK_DIR/scan.git/.gitleaksignore" ] || die "tarama kopyası temiz değil"

report="$WORK_DIR/report.json"
out="$WORK_DIR/gitleaks.log"
rc=0
(
  trap - ERR
  cd "$WORK_DIR/neutral" &&
    "$GITLEAKS_BIN" git "$WORK_DIR/scan.git" \
      --no-banner --no-color --redact \
      --ignore-gitleaks-allow \
      --gitleaks-ignore-path "$ign" \
      --report-format json --report-path "$report" \
      --exit-code 1 \
      --log-opts="${LOG_OPTS[*]}"
) >"$out" 2>&1 || rc=$?
cat "$out"

# Fail-closed denetimleri.
grep -qE '\[git\]|stderr is not empty|( ERR | FTL |level=error|level=fatal)' "$out" && die "gitleaks/git hata bildirdi; tarama güvenilir değil"
[ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || die "gitleaks beklenmeyen çıkış kodu: $rc"
scanned="$(grep -oE '[0-9]+ commits scanned' "$out" | grep -oE '^[0-9]+' | tail -1 || true)"
[ -n "$scanned" ] || die "taranan commit sayısı okunamadı"
# Kısmi tarama: gitleaks beklenenden AZ commit taradıysa (çıktı kesildi, ayrıştırıcı durdu, git akışı yarıda
# bitti…) sonuç güvenilir değildir → başarısız. Fazlası (arşiv dosyaları) kabul edilir ama total'ı aşamaz.
if [ "$scanned" -lt "$expected" ]; then die "kısmi tarama: $expected commit taranmalıydı, $scanned tarandı"; fi
if [ "$scanned" -gt "$total" ]; then die "taranan commit ($scanned) kapsamdaki commit sayısını ($total) aşıyor"; fi
[ -s "$report" ] || die "rapor dosyası yok"
count="$(python3 - "$report" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d, list)
print(len(d))
PY
)" || die "rapor dosyası geçersiz"
if [ "$rc" -eq 0 ] && [ "$count" -ne 0 ]; then die "çıkış kodu 0 ama raporda $count bulgu var"; fi
if [ "$rc" -eq 1 ] && [ "$count" -eq 0 ]; then die "çıkış kodu 1 ama raporda bulgu yok"; fi

if [ "$count" -gt 0 ]; then
  echo "::error::gitleaks: $count bulgu (gizli değerler gizlendi)"
  python3 - "$report" <<'PY' | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
import json, sys
d = json.load(open(sys.argv[1]))
print("| Kural | Dosya | Satır | Commit | Parmak izi |")
print("|---|---|---|---|---|")
for f in d:
    print(f"| {f.get('RuleID','')} | {f.get('File','')} | {f.get('StartLine','')} | {str(f.get('Commit',''))[:12]} | `{f.get('Fingerprint','')}` |")
PY
  exit 1
fi
echo "gitleaks: temiz ($scanned commit tarandı)" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
rm -rf "$WORK_DIR"
