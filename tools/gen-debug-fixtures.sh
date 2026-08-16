#!/usr/bin/env bash
# Regenerate the debug-map harness fixtures (src/test/fixtures/*).
#
# Each fixture is a LIBRARY-BACKED Beguile program compiled with `beguiler --debug`,
# so it emits a real Inform 6 `.dbg` (a bindingless program has no Main and can't).
# We keep the three artifacts the harness loads: .bgldbg, .transpiled.inf, .transpiled.inf.dbg.
#
# Usage: tools/gen-debug-fixtures.sh [path-to-beguiler-repo]
set -euo pipefail

BEG="${1:-$(cd "$(dirname "$0")/../../beguiler" && pwd)}"
LIB_I6="$(cd "$BEG/../inform6/lib" && pwd)"
FIX="$(cd "$(dirname "$0")/.." && pwd)/src/test/fixtures"
BIN="$BEG/beguiler"
BLIB="$BEG/beguiLib"
mkdir -p "$FIX"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

gen() {  # $1=fixture-name  $2=beguile-source
  local name="$1" src="$2" stem out
  stem="$(basename "$src" .bgl)"
  out="$TMP/$name"
  "$BIN" --debug "$src" -lib="$BLIB" -o "$out" >/dev/null
  cp "$out/$stem.bgl.bgldbg"             "$FIX/$name.bgl.bgldbg"
  cp "$out/$stem.bgl.transpiled.inf"     "$FIX/$name.bgl.transpiled.inf"
  cp "$out/$stem.bgl.transpiled.inf.dbg" "$FIX/$name.bgl.transpiled.inf.dbg"
  echo "  ✓ $name"
}

# superposed: exercises a superposed core routine (bgl.util.math) — the anchor-bug regression target.
cat > "$TMP/superposed.bgl" <<EOF
#beguilerSettings { target=Glulx; title="SPMap"; includePaths ="$LIB_I6"; }
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

echo "fixtures regenerated in $FIX"
