/**
 * debugMapHarness.ts — adapter-side debug-map test harness (Jill's half of the
 * debug-hardening net; the emission-side static validator is beguiler's
 * tests/validate_bgldbg.py).
 *
 * Runs WITHOUT an interpreter: it exercises `DebugInfo` (the pure fs/path module
 * that backs the DAP adapter) against library-backed fixtures and asserts the
 * source-map contract the debugger relies on:
 *
 *   - breakpoint-bind sweep — every executable Beguile line (one whose .inf line
 *     carries a sequence point) resolves to ≥1 VM address, so a breakpoint binds;
 *   - forward/reverse round-trip — vmAddrToBgl(addr) is defined and reverse-maps
 *     back to an address set that includes `addr`;
 *   - superposed regression — breakpoints inside a `superposed` core routine bind
 *     (this is the adapter-side guard for the .bgldbg anchor bug fixed 2026-08-16);
 *   - variable types — locals report their declared Beguile type;
 *   - multi-candidate (item #2) — when several .bgl lines share one .inf line,
 *     EVERY candidate still binds (the infToBgl last-write-wins fix).
 *
 * Value+type variable inspection is type-only here; runtime *values* need the
 * interpreter and are deferred with the interpreter swap.
 *
 * Fixtures are regenerated with tools/gen-debug-fixtures.sh.
 *
 * Run:  npm run test:debug
 */
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { DebugInfo } from '../debugInfo';

// ── tiny assertion harness ───────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void {
    if (cond) { passed++; } else { failures.push(msg); }
}

const FIXTURES = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');

interface MapEntry { inf: number; file: string; bgl: number; }

/** Independent parse of the [map] section — used as the EXPECTATION to check DebugInfo against. */
function parseMap(bgldbgPath: string): MapEntry[] {
    const out: MapEntry[] = [];
    let inMap = false;
    for (const raw of fs.readFileSync(bgldbgPath, 'utf8').split('\n')) {
        if (raw.startsWith('[')) { inMap = raw.trim() === '[map]'; continue; }
        if (!inMap) { continue; }
        const p = raw.split('\t');
        if (p.length !== 3) { continue; }
        const inf = parseInt(p[0], 10), bgl = parseInt(p[2], 10);
        if (!isNaN(inf) && !isNaN(bgl)) { out.push({ inf, file: path.resolve(p[1]), bgl }); }
    }
    return out;
}

/**
 * Independent parse of the .dbg — main-file (file-index 0) .inf line → set of
 * VM addresses. A line is REACHABLE only if it has a nonzero address: I6 records
 * `<address>0</address>` for routines that are emitted but never placed in the image
 * (e.g. an uncalled `superposed` core routine), and address 0 is the Glulx header,
 * never executable code. Breakpoints can only bind on reachable lines.
 */
function parseSeqAddrs(dbgPath: string): Map<number, Set<number>> {
    const xml = fs.readFileSync(dbgPath, 'utf8');
    const byLine = new Map<number, Set<number>>();
    const spRe = /<sequence-point>([\s\S]*?)<\/sequence-point>/g;
    let m: RegExpExecArray | null;
    while ((m = spRe.exec(xml)) !== null) {
        const fi = /<file-index>\s*(\d+)\s*<\/file-index>/.exec(m[1]);
        const ln = /<line>\s*(\d+)\s*<\/line>/.exec(m[1]);
        const ad = /<address>\s*(\d+)\s*<\/address>/.exec(m[1]);
        if (ln && (!fi || fi[1] === '0')) {
            const line = parseInt(ln[1], 10);
            (byLine.get(line) ?? byLine.set(line, new Set()).get(line)!).add(ad ? parseInt(ad[1], 10) : 0);
        }
    }
    return byLine;
}
/** .inf lines that carry at least one reachable (nonzero) address. */
function reachableLines(byLine: Map<number, Set<number>>): Set<number> {
    const out = new Set<number>();
    for (const [line, addrs] of byLine) { if ([...addrs].some(a => a !== 0)) { out.add(line); } }
    return out;
}

function loadFixture(name: string): DebugInfo {
    return DebugInfo.load(
        path.join(FIXTURES, `${name}.bgl.bgldbg`),
        path.join(FIXTURES, `${name}.bgl.transpiled.inf.dbg`),
    );
}

// ── generic sweep: breakpoint-bind + forward/reverse round-trip ──────────────
function sweep(name: string): void {
    const di  = loadFixture(name);
    const map = parseMap(path.join(FIXTURES, `${name}.bgl.bgldbg`));
    const byLine    = parseSeqAddrs(path.join(FIXTURES, `${name}.bgl.transpiled.inf.dbg`));
    const reachable = reachableLines(byLine);
    ok(map.length > 0, `${name}: [map] section is non-empty`);

    // Breakpoint-bind sweep: every REACHABLE mapped Beguile line must bind to ≥1 address.
    // Reachable = its .inf line has a nonzero-address sequence point. Excluded, correctly:
    //   - routine-header lines (`[_bglMax a b;`) — no sequence point at all;
    //   - unplaced routines (uncalled `superposed` cores) — sequence points but address 0.
    // Both would make a naive "every mapped line binds" check false-positive.
    let sweptReachable = 0, unreachable = 0;
    for (const e of map) {
        if (byLine.has(e.inf) && !reachable.has(e.inf)) { unreachable++; continue; }
        if (!reachable.has(e.inf)) { continue; }
        sweptReachable++;
        ok(di.bglToVmAddrs(e.file, e.bgl).length >= 1,
           `${name}: breakpoint on ${path.basename(e.file)}:${e.bgl} (inf ${e.inf}) should bind`);
    }
    ok(sweptReachable > 0, `${name}: found reachable mapped lines to sweep`);
    if (unreachable > 0) {
        console.log(`  · ${name}: ${unreachable} mapped line(s) on unplaced (addr-0) routines — not asserted`);
    }

    // Forward/reverse round-trip: every mapped address resolves, and reverse-maps back to it.
    for (const addr of di.allMappedVmAddrs()) {
        const loc = di.vmAddrToBgl(addr);
        ok(loc !== undefined, `${name}: mapped addr ${addr} should resolve to a .bgl location`);
        if (loc) {
            ok(di.bglToVmAddrs(loc.file, loc.line).includes(addr),
               `${name}: round-trip addr ${addr} → ${path.basename(loc.file)}:${loc.line} → addrs must include ${addr}`);
        }
    }
}

// ── superposed regression: breakpoints inside a superposed core routine bind ─
function superposedRegression(): void {
    const di  = loadFixture('superposed');
    const map = parseMap(path.join(FIXTURES, 'superposed.bgl.bgldbg'));
    const reachable = reachableLines(parseSeqAddrs(path.join(FIXTURES, 'superposed.bgl.transpiled.inf.dbg')));
    const mathExec = map.filter(e => e.file.endsWith('_math.bgl') && reachable.has(e.inf));
    ok(mathExec.length >= 1,
       'superposed: _math.bgl (a superposed core routine) has executable mapped lines — ' +
       'pre-fix these all collapsed onto a non-executable anchor');
    for (const e of mathExec) {
        ok(di.bglToVmAddrs(e.file, e.bgl).length >= 1,
           `superposed: breakpoint in _math.bgl:${e.bgl} binds (was 0 before the anchor fix)`);
    }
}

// ── variable types (type half of "variable value+type"; value needs interpreter) ─
function variableTypes(): void {
    const di = loadFixture('locals');
    // Use a normal helper routine `mix`, not the `initialise` entry point: I6 records the
    // entry point as `Initialise` (capitalized) while [types] keys it `initialise`, a
    // name/case skew unique to the entry point. A user helper's .dbg name matches [types].
    let addr: number | undefined;
    for (const a of di.allVmAddrs()) {
        if (di.routineContaining(a)?.name === 'mix') { addr = a; break; }
    }
    ok(addr !== undefined, 'locals: found an address inside routine `mix`');
    if (addr !== undefined) {
        for (const v of ['p', 'q']) {
            ok(di.localVarType(addr, v) === 'int',
               `locals: local \`${v}\` in mix reports type int (got ${di.localVarType(addr, v)})`);
        }
    }
}

// ── variable presentation: nothing hidden; per-local storage metadata is correct ──
// Policy (Jim): the Variables pane conceals nothing. So we assert the FULL local set is
// present, and that Jack's per-local storage metadata (slot vs frame-pool offset) is parsed
// correctly — the data the adapter needs to READ every local, including spilled ones.
function routineByName(di: DebugInfo, name: string) {
    for (const addr of di.allVmAddrs()) {
        const r = di.routineContaining(addr);
        if (r?.name === name) { return r; }
    }
    return undefined;
}

function variablePresentation(): void {
    // for-in: user locals AND the for-in scratch temporaries are all present (nothing dropped).
    {
        const di = loadFixture('forin');
        const r  = routineByName(di, 'sumit');
        ok(r !== undefined, 'forin: routine `sumit` present in .dbg');
        if (r) {
            const names = r.locals.map(l => l.name);
            for (const n of ['total', 'x', '_bglfia1', '_bglfi2']) {
                ok(names.includes(n), `forin: local \`${n}\` present (nothing hidden)`);
            }
            // Jack's `synthetic` marker now covers EVERY compiler-generated local (beguiler ef31001,
            // validator-enforced) — the authoritative signal, no name-guessing. We don't hide on it
            // (show-everything policy), but keep it honest so future annotation can rely on it.
            for (const s of ['_bglfia1', '_bglfi2']) {
                ok(di.localSynthetic(r.startAddr, s), `forin: compiler temp ${s} carries the synthetic marker`);
            }
            for (const u of ['total', 'x']) {
                ok(!di.localSynthetic(r.startAddr, u), `forin: user local \`${u}\` is NOT synthetic`);
            }
        }
    }
    // Z-machine spill: the whole local set is present, and storage metadata is correct —
    // frame-resident locals report `slot` (no spill index); spilled locals carry `_bglFrm-->N`.
    {
        const di = loadFixture('spillz');
        const r  = routineByName(di, 'spill');
        ok(r !== undefined, 'spillz: routine `spill` present in .dbg');
        if (r) {
            const names = r.locals.map(l => l.name);
            ok(names.includes('_bglFrm'), 'spillz: `_bglFrm` frame pointer present (shown, not hidden)');
            ok(names.includes('p') && names.includes('a0'), 'spillz: frame-resident user locals present');
            ok(di.localSpillIndex(r.startAddr, 'a0') === undefined,
               'spillz: frame-resident local a0 has no spill index (storage=slot)');
            ok(di.localSynthetic(r.startAddr, '_bglFrm'), 'spillz: `_bglFrm` carries the synthetic marker (annotatable)');
            const spilled = ['a13', 'a14', 'a15', 'a16', 'a17', 'a18'];
            for (let i = 0; i < spilled.length; i++) {
                ok(di.localSpillIndex(r.startAddr, spilled[i]) === i,
                   `spillz: spilled local ${spilled[i]} reads from _bglFrm-->${i} ` +
                   `(got ${di.localSpillIndex(r.startAddr, spilled[i])})`);
            }
            // spilledLocals() drives the adapter's render: the exact set the adapter reads from the pool.
            const sp = di.spilledLocals(r.startAddr).sort((a, b) => a.index - b.index);
            ok(sp.length === 6 && sp.every((s, i) => s.name === spilled[i] && s.index === i && s.type === 'int'),
               `spillz: spilledLocals() returns a13..a18 at offsets 0..5 as int ` +
               `(got ${sp.map(s => `${s.name}@${s.index}:${s.type}`).join(', ')})`);
            // Cross-artifact contract: the emitted I6 must store spilled locals as `_bglFrm-->N`
            // (with `_bglFrm` = the pool base), which is EXACTLY what the adapter reads as
            // readWord(mem[_bglFrm] + N*WORDSIZE). If the compiler ever changed the spill layout,
            // this trips before the adapter silently reads garbage.
            const inf = fs.readFileSync(path.join(FIXTURES, 'spillz.bgl.transpiled.inf'), 'utf8');
            ok(/_bglFrm\s*=\s*_bglFrameAlloc\(/.test(inf),
               'spillz: emitted I6 sets `_bglFrm = _bglFrameAlloc(…)` (pool base — what the adapter reads from)');
            for (let i = 0; i < sp.length; i++) {
                ok(inf.includes(`_bglFrm-->${i}`),
                   `spillz: emitted I6 addresses spilled local via \`_bglFrm-->${i}\` (matches readWord offset ${i})`);
            }
            console.log(`  · spillz: spilled locals a13..a18 RENDERED via readWord(_bglFrm + N*2); read arithmetic ` +
                        `verified against emitted I6 (_bglFrm-->0..5). Live VALUES still want a running-VM check.`);
        }
    }
}

// ── item #2: multi-candidate — several .bgl lines on one .inf line ALL bind ──
function multiCandidate(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bglmap-'));
    const bgldbg = path.join(dir, 't.bgldbg');
    const dbg    = path.join(dir, 't.inf.dbg');
    // Two DISTINCT .bgl locations both stamped onto .inf line 5; one address at line 5.
    fs.writeFileSync(bgldbg, [
        '[map]',
        `5\t${path.join(dir, 'a.bgl')}\t10`,
        `5\t${path.join(dir, 'b.bgl')}\t20`,
        '[sym]', '[types]', '',
    ].join('\n'));
    fs.writeFileSync(dbg,
        '<given-path>t.inf</given-path>\n' +
        '<sequence-point><address>100</address><file-index>0</file-index><line>5</line></sequence-point>\n');

    const di = DebugInfo.load(bgldbg, dbg);
    // BOTH candidates must bind — pre-fix (last-write-wins) only b.bgl:20 survived.
    ok(di.bglToVmAddrs(path.join(dir, 'a.bgl'), 10).includes(100),
       'item#2: first candidate (a.bgl:10) sharing an .inf line still binds');
    ok(di.bglToVmAddrs(path.join(dir, 'b.bgl'), 20).includes(100),
       'item#2: second candidate (b.bgl:20) sharing an .inf line still binds');
    // Forward resolution is deterministic (first candidate).
    const fwd = di.vmAddrToBgl(100);
    ok(fwd !== undefined && fwd.line === 10,
       'item#2: forward vmAddrToBgl returns the first candidate deterministically');

    fs.rmSync(dir, { recursive: true, force: true });
}

// ── multi-file-index: a library .h re-entered by I6 owns several <given-path> ──
// entries (file-indexes); only ONE carries the sequence-points. A path→addr lookup
// that matches a single index drops the code → library breakpoints never bind.
// (Root cause of WW3's "breakpoint in __orPlayHooks doesn't trigger", 2026-08-16.)
function multiFileIndex(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bglidx-'));
    const bgldbg = path.join(dir, 't.bgldbg');
    const dbg    = path.join(dir, 't.inf.dbg');
    const lib    = path.join(dir, 'lib.h');
    fs.writeFileSync(bgldbg, ['[map]', '[sym]', '[types]', ''].join('\n'));
    // lib.h appears TWICE (indexes 1 and 2). Only index 2 carries the seq-point at line 42;
    // index 1 (the first re-entry) has none — exactly the WW3 .dbg shape.
    fs.writeFileSync(dbg,
        '<given-path>t.inf</given-path>\n' +          // index 0 (main)
        '<given-path>lib.h</given-path>\n' +          // index 1 — no seq-points
        '<given-path>lib.h</given-path>\n' +          // index 2 — carries the code
        '<sequence-point><address>200</address><file-index>2</file-index><line>42</line></sequence-point>\n' +
        '<sequence-point><address>208</address><file-index>2</file-index><line>44</line></sequence-point>\n');

    const di = DebugInfo.load(bgldbg, dbg);
    // Pre-fix: vmAddrsForInfLine matched only the FIRST index (1, empty) → [] → BP never binds.
    ok(di.vmAddrsForInfLine(42, lib).includes(200),
       'multi-index: breakpoint on a library line whose code lives under a later file-index binds');
    ok(di.vmAddrsForInfLine(44, lib).includes(208),
       'multi-index: a second line in the re-entered file also binds');
    // vmAddrsForInfFile (I6 step-over stop set) must union all indexes too.
    const fileAddrs = di.vmAddrsForInfFile(lib);
    ok(fileAddrs.includes(200) && fileAddrs.includes(208),
       'multi-index: vmAddrsForInfFile unions all indexes of the physical file');

    fs.rmSync(dir, { recursive: true, force: true });
}

// ── run ──────────────────────────────────────────────────────────────────────
function main(): void {
    sweep('superposed');
    sweep('locals');
    superposedRegression();
    variableTypes();
    variablePresentation();
    multiCandidate();
    multiFileIndex();

    const total = passed + failures.length;
    console.log(`\ndebug-map harness: ${passed}/${total} checks passed`);
    if (failures.length) {
        console.log(`\n${failures.length} FAILED:`);
        for (const f of failures) { console.log(`  ✗ ${f}`); }
        process.exit(1);
    }
    console.log('all green ✓');
}

main();
