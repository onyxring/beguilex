#!/usr/bin/env bash
# Regenerate the debug-map harness fixtures (src/test/fixtures/*).
#
# Each fixture is a LIBRARY-BACKED Beguile program compiled with `beguiler --debug`,
# so it emits a real Inform 6 `.dbg` (a bindingless program has no Main and can't).
# We keep the three artifacts the harness loads: .bgldbg, .transpiled.inf, .transpiled.inf.dbg.
#
# Usage: tools/gen-debug-fixtures.sh [--check] [path-to-beguiler-repo]
#
#   (no flag)  regenerate the fixtures in place
#   --check    regenerate to the same scratch dir and DIFF against the committed
#              fixtures, exiting non-zero on any difference. Nothing is written.
#
# --check is what makes fixture staleness loud. The harnesses themselves compile
# nothing: they read these committed bytes, so a fixture that no longer matches
# what the compiler emits still passes. Only this comparison can say otherwise.
#
# Generation is deterministic, which is what lets --check be trustworthy:
#   - the build dir is a fixed path, not mktemp -d, because the source path is
#     recorded inside the .bgldbg and the I6 .dbg;
#   - each program pins `Serial` below, because I6 otherwise stamps the build
#     date into the story file and the .dbg, so fixtures would differ by day.
# Regenerating with no real change must produce an empty diff. If it does not,
# something above has regressed and --check is crying wolf — fix it there.
set -euo pipefail

MODE=generate
BEGARG=""
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    *)       BEGARG="$a" ;;
  esac
done

BEG="${BEGARG:-$(cd "$(dirname "$0")/../../beguiler" 2>/dev/null && pwd)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/src/test/fixtures"
BIN="$BEG/beguiler"
BLIB="$BEG/beguiLib"

# Fixed, not mktemp -d: this path is embedded in the generated debug files.
TMP="$ROOT/.fixture-build"

# Any 6-digit date. Fixed so the story file and .dbg do not change by the day.
SERIAL_PIN="200101"

if [ ! -x "$BIN" ]; then
  echo "SKIP: no beguiler binary at $BIN - cannot ${MODE} fixtures."
  echo "      (build it with: make -C \"$BEG\")"
  exit 0
fi
if [ ! -d "$BEG/../inform6/stdlib" ]; then
  echo "SKIP: no I6 standard library at $BEG/../inform6/stdlib - cannot ${MODE} fixtures."
  echo "      (git submodule update --init inform6/stdlib)"
  exit 0
fi
LIB_I6="$(cd "$BEG/../inform6/stdlib" && pwd)"

mkdir -p "$FIX"
rm -rf "$TMP"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

DRIFT=0
# Copy a freshly built artifact into the fixture set, or in --check mode compare it.
emit() {  # $1=built file  $2=committed fixture path
  if [ "$MODE" = check ]; then
    if [ ! -f "$2" ]; then
      echo "  DRIFT: $(basename "$2") - no committed fixture"; DRIFT=1
    elif ! cmp -s "$1" "$2"; then
      echo "  DRIFT: $(basename "$2")"; DRIFT=1
    fi
  else
    cp "$1" "$2"
  fi
}

gen() {  # $1=fixture-name  $2=beguile-source
  local name="$1" src="$2" stem out
  stem="$(basename "$src" .bgl)"
  out="$TMP/$name"
  "$BIN" --debug "$src" -lib="$BLIB" -o "$out" >/dev/null
  emit "$out/$stem.bgl.bgldbg"             "$FIX/$name.bgl.bgldbg"
  emit "$out/$stem.bgl.transpiled.inf"     "$FIX/$name.bgl.transpiled.inf"
  emit "$out/$stem.bgl.transpiled.inf.dbg" "$FIX/$name.bgl.transpiled.inf.dbg"
  # Story file (for the RUNTIME harness): whichever the target produced (.z8 / .ulx).
  [ "$MODE" = check ] || rm -f "$FIX/$name.z8" "$FIX/$name.ulx"
  local story=""
  for ext in z8 ulx zblorb; do
    if [ -f "$out/$stem.$ext" ]; then story="$out/$stem.$ext"; emit "$story" "$FIX/$name.$ext"; break; fi
  done
  echo "  ✓ $name${story:+ (+$(basename "$story"|sed 's/.*\.//') story)}"
}

# superposed: exercises a superposed core routine (bgl.util.math) — the anchor-bug regression target.
cat > "$TMP/superposed.bgl" <<EOF
#beguilerSettings { target=Glulx; title="SPMap"; includePaths ="$LIB_I6"; }
#i6 { Serial "$SERIAL_PIN"; }
#includeI6 "parser"
#includeI6 "verblib"
void initialise(){
    int a = bgl.util.math.min(3, 7);
    int b = bgl.util.math.max(3, 7);
    print(a); print(b);
}
#includeI6 "grammar"
EOF
gen superposed "$TMP/superposed.bgl"

# locals: typed locals in a normal helper routine `mix` (called, so it's placed) for
# the variable-type checks — NOT the `initialise` entry point (I6 renames it `Initialise`).
cat > "$TMP/locals.bgl" <<EOF
#beguilerSettings { target=Glulx; title="Locals"; includePaths ="$LIB_I6"; }
#i6 { Serial "$SERIAL_PIN"; }
#includeI6 "parser"
#includeI6 "verblib"
int mix(int p){
    int q = p * 2;
    return q + 1;
}
void initialise(){
    int x = 5;
    int z = mix(x);
    print(z);
}
#includeI6 "grammar"
EOF
gen locals "$TMP/locals.bgl"

# forin (Glulx): a for-in loop emits scratch temporaries (_bglfia*/_bglfi*) that must be
# HIDDEN from the Variables pane — the scratch-leak regression.
cat > "$TMP/forin.bgl" <<EOF
#beguilerSettings { target=Glulx; title="ForIn"; includePaths ="$LIB_I6"; }
#i6 { Serial "$SERIAL_PIN"; }
#includeI6 "parser"
#includeI6 "verblib"
int sumit(){
    int total = 0;
    for(int x in {10, 20, 30}){ total = total + x; }
    return total;
}
void initialise(){ print(sumit()); }
#includeI6 "grammar"
EOF
gen forin "$TMP/forin.bgl"

# spillz (Z8): >15 locals spill on the Z-machine — exercises the `_bglFrm` frame-pointer leak
# (hidden) and documents the not-yet-displayed spilled locals a13..a18.
cat > "$TMP/spillz.bgl" <<EOF
#beguilerSettings { target=Z8; title="SpillZ"; includePaths ="$LIB_I6"; }
#i6 { Serial "$SERIAL_PIN"; }
#includeI6 "parser"
#includeI6 "verblib"
int spill(int p){
    int a0=p; int a1=1; int a2=2; int a3=3; int a4=4; int a5=5; int a6=6; int a7=7;
    int a8=8; int a9=9; int a10=10; int a11=11; int a12=12; int a13=13; int a14=14;
    int a15=15; int a16=16; int a17=17; int a18=18;
    return a0+a1+a2+a3+a4+a5+a6+a7+a8+a9+a10+a11+a12+a13+a14+a15+a16+a17+a18;
}
void initialise(){ print(spill(7)); }
#includeI6 "grammar"
EOF
gen spillz "$TMP/spillz.bgl"

# rt_calls: calls + recursion + known locals — the runtime harness's step-in/out + values workhorse.
# Built to BOTH targets (rt_calls_z = Z8, rt_calls_g = Glulx) for the parametrized runtime harness.
rt_body() {  # $1 = target
cat <<EOF
#beguilerSettings { target=$1; title="RtCalls"; includePaths ="$LIB_I6"; }
#i6 { Serial "$SERIAL_PIN"; }
#includeI6 "parser"
#includeI6 "verblib"
int add(int a, int b){
    int s = a + b;
    return s;
}
int fib(int n){
    if (n < 2){ return n; }
    return fib(n - 1) + fib(n - 2);
}
void initialise(){
    int x = 5;
    int y = add(x, 3);
    int f = fib(6);
    print(y);
    print(f);
}
#includeI6 "grammar"
EOF
}
rt_body Z8    > "$TMP/rt_calls_z.bgl"; gen rt_calls_z "$TMP/rt_calls_z.bgl"
rt_body Glulx > "$TMP/rt_calls_g.bgl"; gen rt_calls_g "$TMP/rt_calls_g.bgl"

if [ "$MODE" = check ]; then
  if [ "$DRIFT" -ne 0 ]; then
    echo ""
    echo "FIXTURES ARE STALE - the committed fixtures no longer match what the"
    echo "compiler emits. The harnesses cannot detect this on their own; they"
    echo "read these bytes rather than producing any."
    echo "Refresh them with:  tools/gen-debug-fixtures.sh"
    exit 1
  fi
  echo "fixtures up to date"
else
  echo "fixtures regenerated in $FIX"
fi
