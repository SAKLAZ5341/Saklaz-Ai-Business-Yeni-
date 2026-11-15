#!/usr/bin/env bash
# tools/ci/gitleaks-scan.sh öz-sınaması. Yalnızca geçici dizinlerdeki sentetik depolarla çalışır;
# sahte anahtarlar çalışma anında rastgele üretilir (bu dosyada anahtar biçimli değer yoktur) ve
# her senaryodan sonra hiçbir çıktıda görünmediği denetlenir.
#   GITLEAKS_BIN=/yol/gitleaks bash tools/ci/gitleaks-scan.test.sh
set -Eeuo pipefail
: "${GITLEAKS_BIN:?GITLEAKS_BIN gerekli}"
SCAN="$(cd "$(dirname "$0")" && pwd)/gitleaks-scan.sh"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/gls-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
REAL_GIT="$(command -v git)"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --file "$T/gitconfig" user.name sinama
git config --file "$T/gitconfig" user.email sinama@example.invalid
git config --file "$T/gitconfig" init.defaultBranch main
git config --file "$T/gitconfig" advice.detachedHead false

pass=0; fail=0; KEYS="$T/keys"; : >"$KEYS"
key() { # rastgele, sahte Stripe biçimli anahtar satırı
  local k; k="sk_$(printf live)_$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  echo "$k" >>"$KEYS"; printf 'stripe_api_key = "%s"\n' "$k"
}
commit() { git add -A && git commit -qm "$1"; }
# run <ad> <beklenen çıkış kodu> <ortam...> : betiği çalıştırır, kodu ve gizli değer sızıntısını denetler
run() {
  local name="$1" want="$2"; shift 2
  local outf="$T/out.$pass.$fail" rc=0
  env "$@" GITLEAKS_BIN="${FAKE_BIN:-$GITLEAKS_BIN}" WORK_DIR="$T/work" bash "$SCAN" >"$outf" 2>&1 || rc=$?
  local leak=0; while read -r k; do [ -n "$k" ] && grep -qF "$k" "$outf" && leak=1; done <"$KEYS"
  if [ "$rc" = "$want" ] && [ "$leak" = 0 ]; then pass=$((pass + 1)); echo "  ✓ $name (çıkış $rc)"
  else fail=$((fail + 1)); echo "  ✗ $name — çıkış $rc, beklenen $want, gizli değer sızıntısı: $leak"; sed 's/^/      /' "$outf"; fi
  LAST_OUT="$outf"
}
expect_in_last() { if grep -qE "$1" "$LAST_OUT"; then pass=$((pass + 1)); echo "  ✓   çıktıda: $1"; else fail=$((fail + 1)); echo "  ✗   çıktıda yok: $1"; fi; }

# ---------------------------------------------------------------- PR senaryoları
echo "PR kipi:"
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/dev" 2>/dev/null; cd "$T/dev"
echo a >a.txt; commit base; git push -q origin main
git checkout -qb clean; echo temiz >c.txt; commit temiz; git push -q origin clean
git checkout -q main; git checkout -qb addrm; key >s1.txt; commit "anahtar ekle"; git rm -q s1.txt; commit "anahtarı sil"; git push -q origin addrm
git checkout -q main; git checkout -qb conflict; echo pr >a.txt; commit "pr tarafı"
git checkout -q main; echo main >a.txt; commit "main tarafı"; git push -q origin main
git checkout -q conflict; git merge -q main >/dev/null 2>&1 || true; { echo cozuldu; key; } >a.txt; commit "çakışma çözümünde anahtar"; git push -q origin conflict
git checkout -q main; git checkout -qb evil; echo e >e.txt; commit e
git checkout -q main; echo m2 >m2.txt; commit m2; git push -q origin main
git checkout -q evil; git merge -q --no-commit main >/dev/null; key >evil.txt; git add evil.txt; git commit -qm "temiz birleştirmeye gizlice dosya"; git push -q origin evil
git checkout -q main; key >mainsecret.txt; commit "main'de anahtar (main push'ta taranır)"; git push -q origin main
git checkout -q -b mergemain origin/clean; git merge -q --no-edit origin/main >/dev/null; echo x >x.txt; commit x; git push -q origin mergemain
git checkout -q -b allow origin/clean; printf '%s # gitleaks:allow\n' "$(key)" >al.txt; commit "satır içi bastırma"; git push -q origin allow
git checkout -q -b toml origin/clean; printf '[extend]\nuseDefault = true\n' >.gitleaks.toml; commit toml; git push -q origin toml
git checkout -q -b selfignore origin/clean; key >si.txt; commit "anahtar"; SI_SHA=$(git rev-parse HEAD)
echo "$SI_SHA:si.txt:stripe-access-token:1" >.gitleaksignore; echo "$SI_SHA:si.txt:generic-api-key:1" >>.gitleaksignore; commit "PR kendi ignore'u"; git push -q origin selfignore
# hedef dalda (main) güvenilir girdi: geçmişteki bir commit için
git checkout -q -b histfix origin/clean; key >h.txt; commit "tarihsel anahtar"; H_SHA=$(git rev-parse HEAD); git rm -q h.txt; commit "kaldır"; git push -q origin histfix
git checkout -q -b trustbase origin/main; { echo "# güvenilir girdi"; echo "$H_SHA:h.txt:stripe-access-token:1"; echo "$H_SHA:h.txt:generic-api-key:1"; } >.gitleaksignore; commit "güvenilir ignore"; git push -q origin trustbase

git clone -q "$T/origin.git" "$T/ci" 2>/dev/null; cd "$T/ci"; git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
sha() { git -C "$T/ci" rev-parse "refs/remotes/origin/$1"; }
R=(REPO_DIR="$T/ci" SCAN_MODE=pr DEFAULT_BRANCH=main)
run "temiz PR" 0 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha clean)"
run "eklenip silinen anahtar" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha addrm)"
run "çakışma çözümünde anahtar (birleştirme commit'i)" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha conflict)"
run "temiz birleştirmeye gizlice eklenen dosya" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha evil)"
run "main birleştirilen PR: main içeriği tekrar raporlanmaz" 0 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha mergemain)"
run "satır içi gitleaks:allow yok sayılır" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha allow)"
run ".gitleaks.toml yasak" 2 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha toml)"
expect_in_last "gitleaks.toml kullanımı yasak"
run "PR'ın kendi .gitleaksignore'u dikkate alınmaz" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha selfignore)"
run "hedefi korumasız özellik dalı: o dalın .gitleaksignore'una GÜVENİLMEZ" 1 "${R[@]}" BASE_REF=trustbase HEAD_SHA="$(sha histfix)"
expect_in_last "Güvenilir .gitleaksignore kaynağı: refs/remotes/origin/main"
run "aynı commit, varsayılan dalda girdi yoksa yakalanır" 1 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha histfix)"
run "varsayılan dal adı verilmezse → hata" 2 REPO_DIR="$T/ci" SCAN_MODE=pr BASE_REF=main HEAD_SHA="$(sha clean)"
run "varsayılan dal referansı yoksa → hata" 2 REPO_DIR="$T/ci" SCAN_MODE=pr DEFAULT_BRANCH=yok BASE_REF=main HEAD_SHA="$(sha clean)"
run "boş aralık" 0 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha main)"
expect_in_last "— 0 commit"
run "geçersiz SHA biçimi" 2 "${R[@]}" BASE_REF=main 'HEAD_SHA=x;id'
run "olmayan SHA" 2 "${R[@]}" BASE_REF=main HEAD_SHA=0123456789abcdef0123456789abcdef01234567
run "olmayan hedef dal" 2 "${R[@]}" BASE_REF=yok HEAD_SHA="$(sha clean)"
run "geçersiz hedef dal adı" 2 "${R[@]}" BASE_REF='../x' HEAD_SHA="$(sha clean)"
run "bilinmeyen kip" 2 REPO_DIR="$T/ci" SCAN_MODE=baska
run "SCAN_MODE verilmezse → hata (2, bulgu kodu 1 DEĞİL)" 2 REPO_DIR="$T/ci"
run "HEAD_SHA verilmezse → hata (2)" 2 "${R[@]}" BASE_REF=main

# Varsayılan dala (incelenmiş) ignore girdisi eklenince: hedef hangi dal olursa olsun uygulanır.
cd "$T/dev"; git checkout -q main; git pull -q origin main 2>/dev/null || true
{ echo "# varsayılan dalda güvenilir girdi"; echo "$H_SHA:h.txt:stripe-access-token:1"; echo "$H_SHA:h.txt:generic-api-key:1"; } >.gitleaksignore; commit "varsayılan dalda ignore"; git push -q origin main
cd "$T/ci"; git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
run "varsayılan daldaki güvenilir girdi uygulanır (hedef main)" 0 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha histfix)"
run "varsayılan daldaki güvenilir girdi uygulanır (hedef özellik dalı)" 0 "${R[@]}" BASE_REF=trustbase HEAD_SHA="$(sha histfix)"

# ---------------------------------------------------------------- git hatası (fail-open denemesi)
echo "git hatası:"
mkdir -p "$T/wrap"
cat >"$T/wrap/git" <<EOF
#!/usr/bin/env bash
# yalnızca gitleaks'in tarama kopyası üzerindeki "git -C <kopya> log -p -U0" çağrısını bozar
if [ "\$1" = "-C" ] && [[ "\$2" == *scan.git ]] && [ "\$3" = log ]; then
  case "\${GIT_SIM:-}" in
    fatal) echo "fatal: benzetilmiş git hatası" >&2; exit 128 ;;
    warn)  echo "error: benzetilmiş uyarı" >&2; exec "$REAL_GIT" "\$@" ;;
    empty) exit 0 ;;
  esac
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$T/wrap/git"
run "git ölümcül hata → başarısız" 2 PATH="$T/wrap:$PATH" GIT_SIM=fatal "${R[@]}" BASE_REF=main HEAD_SHA="$(sha addrm)"
run "git stderr çıktısı → başarısız" 2 PATH="$T/wrap:$PATH" GIT_SIM=warn "${R[@]}" BASE_REF=main HEAD_SHA="$(sha addrm)"
run "git boş çıktı (0 commit tarandı) → başarısız" 2 PATH="$T/wrap:$PATH" GIT_SIM=empty "${R[@]}" BASE_REF=main HEAD_SHA="$(sha clean)"
expect_in_last "0 commit tarandı"
printf '#!/bin/sh\necho 8.0.0\n' >"$T/oldgl"; chmod +x "$T/oldgl"
FAKE_BIN="$T/oldgl" run "yanlış gitleaks sürümü" 2 "${R[@]}" BASE_REF=main HEAD_SHA="$(sha clean)"

# ---------------------------------------------------------------- fork PR (actions/checkout v7, fetch-depth 0)
echo "fork PR:"
git clone -q "$T/origin.git" "$T/fork" 2>/dev/null; cd "$T/fork"; git checkout -qb forkpr origin/main; key >fork.txt; commit "fork anahtarı"; F_SHA=$(git rev-parse HEAD)
git push -q "$T/origin.git" "HEAD:refs/pull/1/head"   # GitHub, fork kaynağını taban depoda refs/pull/N/head olarak tutar
git clone -q "$T/origin.git" "$T/mk" 2>/dev/null; cd "$T/mk"; git fetch -q origin "$F_SHA"; git merge -q --no-ff --no-edit "$F_SHA" >/dev/null; git push -q origin "HEAD:refs/pull/1/merge"; M_SHA=$(git rev-parse HEAD)
git init -q "$T/forkci"; cd "$T/forkci"; git remote add origin "$T/origin.git"
git -c protocol.version=2 fetch -q --no-tags --prune --no-recurse-submodules origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' "+$M_SHA:refs/remotes/pull/1/merge"
git checkout -q --force refs/remotes/pull/1/merge
if [ -z "$(git for-each-ref --contains "$F_SHA" refs/remotes/origin)" ] && [ "$(git rev-parse HEAD^2)" = "$F_SHA" ]; then pass=$((pass + 1)); echo "  ✓ kaynak SHA yalnızca birleştirme ref'inden erişilebilir (fork)"; else fail=$((fail + 1)); echo "  ✗ fork kurulumu beklenen gibi değil"; fi
run "fork PR'ındaki anahtar yakalanır" 1 REPO_DIR="$T/forkci" SCAN_MODE=pr DEFAULT_BRANCH=main BASE_REF=main HEAD_SHA="$F_SHA"

# ---------------------------------------------------------------- push kipi
echo "push kipi:"
git clone -q "$T/origin.git" "$T/pushci" 2>/dev/null; cd "$T/pushci"
P=(REPO_DIR="$T/pushci" SCAN_MODE=push DEFAULT_BRANCH=main PUSH_REF=refs/heads/main)
run "main tam geçmiş (main'deki anahtar)" 1 "${P[@]}" EXPECTED_SHA="$(git rev-parse HEAD)"
run "HEAD beklenen commit değil" 2 "${P[@]}" EXPECTED_SHA="$(git rev-parse HEAD~1)"
run "push kipi varsayılan dal dışında → hata" 2 REPO_DIR="$T/pushci" SCAN_MODE=push DEFAULT_BRANCH=main PUSH_REF=refs/heads/ozellik EXPECTED_SHA="$(git rev-parse HEAD)"
git checkout -q -b clean-main "$(sha clean)"
run "temiz geçmiş" 0 "${P[@]}" EXPECTED_SHA="$(git rev-parse HEAD)"

# ---------------------------------------------------------------- full kipi (B2)
echo "full kipi:"
git init -q "$T/full"; cd "$T/full"; echo b >b.txt; commit base
for r in branchonly tagonly anntagonly pullonly; do git checkout -q -b "$r" main; key >"$r.txt"; commit "$r"; done
git checkout -q main
git update-ref refs/remotes/origin/branchonly branchonly; git branch -q -D branchonly
git tag tagonly-light tagonly; git branch -q -D tagonly
git tag -a anntag -m ann anntagonly; git branch -q -D anntagonly
git update-ref refs/remotes/pull/9/head pullonly; git branch -q -D pullonly
run "dal, hafif/açıklamalı etiket ve PR referansı taranır" 1 REPO_DIR="$T/full" SCAN_MODE=full TRUSTED_REF=main
for f in branchonly.txt tagonly.txt anntagonly.txt pullonly.txt; do expect_in_last "\| $f \|"; done
git checkout -q -b tomlref main; printf '[extend]\nuseDefault = true\n' >.gitleaks.toml; commit toml; git checkout -q main
run "herhangi bir referansta .gitleaks.toml → başarısız" 2 REPO_DIR="$T/full" SCAN_MODE=full TRUSTED_REF=main
run "olmayan güvenilir referans" 2 REPO_DIR="$T/full" SCAN_MODE=full TRUSTED_REF=refs/heads/yok

echo
echo "Öz-sınama: $pass geçti, $fail başarısız"
[ "$fail" -eq 0 ]
