/**
 * runtimeHarness.ts — RUNTIME debug harness (Stage 1 of the runtime-hardening phase).
 *
 * Unlike debugMapHarness.ts (static: map/metadata only), this actually RUNS the compiled
 * story in a headless interpreter, driving the SHIPPED debug hooks (media/zvm-debug.js,
 * media/quixe-debug.js) and the real DebugInfo — then asserts the behaviors users hit:
 *   • breakpoint fidelity  — execution stops on the expected .bgl line;
 *   • variable values      — locals/params/spilled read back correctly at the stop;
 *   • stepping             — step in/over/out land on the expected line;
 *   • call stack.
 *
 * Parametrized over BOTH interpreters: ZVM (ifvms, Z-machine, .z8) and Quixe (Glulx, .ulx).
 * No webview/GlkOte — a stubbed `window` + the real hooks, so it's a fast Node test.
 * See project_debug_runtime_harness_spike memory for the proven mechanics.
 *
 * Run:  npm run test:debug:runtime
 */
import * as fs   from 'fs';
import * as path from 'path';
import { DebugInfo } from '../../debugInfo';
import { computeStep, routeBreak } from '../../debugStepLogic';

const NM  = path.join(__dirname, '..', '..', '..', 'node_modules');
const FIX = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures');
const MEDIA = path.join(__dirname, '..', '..', '..', 'media');

// ── assertion harness ────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) { passed++; } else { failures.push(msg); } }
function eq(actual: any, expected: any, msg: string): void {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

// ── .dbg helpers: routine ranges + their sequence points ─────────────────────
interface SeqPt { addr: number; infLine: number; }
/** routine name → sequence points (file-index 0, nonzero address) inside it, sorted by addr. */
function routineSeqPts(dbgPath: string): Map<string, SeqPt[]> {
    const xml = fs.readFileSync(dbgPath, 'utf8');
    const ranges: { name: string; lo: number; hi: number }[] = [];
    const rRe = /<routine>([\s\S]*?)<\/routine>/g;
    let m: RegExpExecArray | null;
    while ((m = rRe.exec(xml)) !== null) {
        const id = /<identifier>([^<]+)</.exec(m[1]);
        const addrs = [...m[1].matchAll(/<address>\s*(\d+)/g)].map(a => parseInt(a[1], 10));
        if (id && addrs.length) { ranges.push({ name: id[1], lo: Math.min(...addrs), hi: Math.max(...addrs) }); }
    }
    const out = new Map<string, SeqPt[]>();
    const spRe = /<sequence-point>([\s\S]*?)<\/sequence-point>/g;
    while ((m = spRe.exec(xml)) !== null) {
        const fi = /<file-index>\s*(\d+)/.exec(m[1]);
        const ad = /<address>\s*(\d+)/.exec(m[1]);
        const ln = /<line>\s*(\d+)/.exec(m[1]);
        if (!ad || (fi && fi[1] !== '0')) { continue; }
        const addr = parseInt(ad[1], 10);
        if (addr === 0) { continue; }
        for (const r of ranges) {
            if (addr >= r.lo && addr <= r.hi) {
                (out.get(r.name) ?? out.set(r.name, []).get(r.name)!).push({ addr, infLine: ln ? parseInt(ln[1], 10) : 0 });
            }
        }
    }
    for (const v of out.values()) { v.sort((a, b) => a.addr - b.addr); }
    return out;
}

// ── driver interface ─────────────────────────────────────────────────────────
interface Stop { pc: number; reason: 'break' | 'step'; }
interface Frame { funcAddr: number; returnPC: number; locals: { [off: number]: number }; }
interface VmState { frames: Frame[]; globals: { [addr: number]: number }; }
interface Driver {
    kind: 'zvm' | 'quixe';
    setBreakpoints(addrs: number[]): void;
    setAllSeqPts(addrs: number[]): void;   // block-splitter needs every seq-pt for stepping to fire
    run(): Stop | null;          // boot to first stop (breakpoints must be set first)
    cont(): Stop | null;
    /** Step: resume until the next seq-pt in `stopAddrs` (empty = ANY seq-pt = step-in), skipping `skipAddrs`. */
    step(stopAddrs: number[], skipAddrs?: number[]): Stop | null;
    getState(): VmState;
    readWord(addr: number): number | null;
    setLocal(stackIdx: number, offset: number, val: number): boolean;
}

/** All file-index-0 nonzero sequence-point addresses (for the step block-splitter). */
function allSeqPtAddrs(dbgPath: string): number[] {
    const xml = fs.readFileSync(dbgPath, 'utf8');
    const out = new Set<number>();
    const spRe = /<sequence-point>([\s\S]*?)<\/sequence-point>/g;
    let m: RegExpExecArray | null;
    while ((m = spRe.exec(xml)) !== null) {
        const fi = /<file-index>\s*(\d+)/.exec(m[1]);
        const ad = /<address>\s*(\d+)/.exec(m[1]);
        if (ad && (!fi || fi[1] === '0')) { const a = parseInt(ad[1], 10); if (a) { out.add(a); } }
    }
    return [...out];
}

// ── ZVM engine (Z-machine, ifvms) ────────────────────────────────────────────
// The shipped hooks (zvm-debug.js) patch ZVM.prototype and assign window._bgl* readers
// ONCE (require is cached). So we set up a single shared `window` + hooks, and make each
// driver a thin per-VM wrapper over it. Stops land in the shared `eng.stop`.
let zvmEngine: any = null;
function zvmSetup(): any {
    if (zvmEngine) { return zvmEngine; }
    const win: any = {
        _bglBP: new Set<number>(), _bglAllSeqPtAddrs: new Set<number>(),
        _bglSkipPC: null, _bglPausedPC: null, _bglBreakPausing: false,
        _bglStepMode: false, _bglStepStopAt: null, _bglStepSkipAddrs: null,
        _bglLog: () => {}, _bglTrackedGlobalAddrs: null,
    };
    const eng: any = { win, stop: null as Stop | null };
    win._bglOnBreak = (pc: number) => { eng.stop = { pc, reason: 'break' }; win._bglPausedPC = pc; };
    win._bglOnStep  = (pc: number) => { eng.stop = { pc, reason: 'step'  }; win._bglPausedPC = pc; };
    (global as any).window = win;
    eng.ZVM = require(path.join(NM, 'ifvms', 'src', 'zvm.js'));
    (global as any).ZVM = eng.ZVM;
    require(path.join(MEDIA, 'zvm-debug.js'));   // patches ZVM.prototype + defines win._bglReadWord/_bglGetVmState
    eng.readline = require('readline');
    eng.GlkOte = require(path.join(NM, 'glkote-term'));
    eng.MuteStream = require(path.join(NM, 'mute-stream'));
    zvmEngine = eng;
    return eng;
}
function makeZvmDriver(storyPath: string): Driver {
    const eng = zvmSetup();
    const win = eng.win;
    // reset control globals for a fresh run
    win._bglBP = new Set(); win._bglAllSeqPtAddrs = new Set();
    win._bglStepMode = false; win._bglStepStopAt = null; win._bglStepSkipAddrs = null;
    win._bglSkipPC = null; win._bglPausedPC = null; win._bglBreakPausing = false;

    const stdout = new eng.MuteStream();
    const rl = eng.readline.createInterface({ input: process.stdin, output: stdout, prompt: '' });
    const rl_opts = { rl, stdin: process.stdin, stdout };
    const vm = new eng.ZVM();
    const options = { vm, Dialog: new eng.GlkOte.Dialog(rl_opts), Glk: eng.GlkOte.Glk, GlkOte: new eng.GlkOte(rl_opts) };
    vm.prepare(fs.readFileSync(storyPath), options);
    let booted = false;

    return {
        kind: 'zvm',
        setBreakpoints(addrs) { win._bglBP = new Set(addrs); if (vm.jit) { vm.jit = {}; } },
        setAllSeqPts(addrs) { win._bglAllSeqPtAddrs = new Set(addrs); },
        run() {
            eng.stop = null;
            if (!booted) { booted = true; win._bglZvmInstance = vm; options.Glk.init(options); }
            return eng.stop;
        },
        cont() { eng.stop = null; win._bglSkipPC = win._bglPausedPC; win._bglPausedPC = null; vm._bglContinue(); return eng.stop; },
        step(stopAddrs, skipAddrs) {
            const curPc = win._bglPausedPC;      // where we're paused now
            eng.stop = null;
            // The injected step-check doesn't honor _bglSkipPC, so the CURRENT address must be
            // in the skip set or the step immediately re-stops there without advancing.
            const skip = new Set<number>(skipAddrs ?? []);
            if (curPc != null) { skip.add(curPc); }
            win._bglSkipPC = curPc; win._bglPausedPC = null;
            win._bglStepSkipAddrs = skip.size ? skip : null;
            win._bglStepStopAt = stopAddrs && stopAddrs.length ? new Set(stopAddrs) : null;
            win._bglStepMode = true;
            if (vm.jit) { vm.jit = {}; }
            vm._bglContinue();
            return eng.stop;
        },
        getState() { return win._bglGetVmState(); },
        readWord(addr) { return win._bglReadWord(addr); },
        setLocal(stackIdx, offset, val) { return win._bglSetLocal(stackIdx, offset, val); },
    };
}

// ── Quixe engine (Glulx) ─────────────────────────────────────────────────────
// media/quixe-debug.js is a self-contained DEBUG BUNDLE (patched Quixe + GiDispa + GiLoad);
// its GiLoad.load_run() reads window.Quixe dynamically, and compile_path splits paths at
// window._bglSeqPts addresses (so breakpoint addresses become path-starts — line ~555).
// Boot: require app.js (fake browser + Glk + Dialog), set control globals, load the debug
// bundle, point window.* at it, then drive the bundle's own GiLoad.
let quixeEngine: any = null;
function quixeSetup(): any {
    if (quixeEngine) { return quixeEngine; }
    require(path.join(NM, 'quixe', 'app.js'));   // sets global.window (fake browser) + Glk + Dialog + jQuery
    const win: any = (global as any).window;
    Object.assign(win, {
        _bglBP: new Set<number>(), _bglSeqPts: new Set<number>(),
        _bglSkipPC: null, _bglPausedPC: null, _bglBreakPausing: false, _bglIsPaused: false,
        _bglStepMode: false, _bglStepStopAt: null, _bglStepSkipAddrs: null,
        _bglLog: () => {}, _bglTrackedGlobalAddrs: null,
        _bglCurrentVmFunc: null, _bglCurrentIosys: undefined,
    });
    const eng: any = { win, stop: null as Stop | null };
    win._bglOnBreak = (pc: number) => { eng.stop = { pc, reason: 'break' }; win._bglPausedPC = pc; };
    win._bglOnStep  = (pc: number) => { eng.stop = { pc, reason: 'step'  }; win._bglPausedPC = pc; };
    const ru = (p: string) => { try { delete require.cache[require.resolve(p)]; } catch (e) {} return require(p); };
    ru(path.join(MEDIA, 'quixe-debug.js'));      // debug bundle: sets global Quixe + GiDispa + GiLoad
    win.Quixe = (global as any).Quixe; win.GiDispa = (global as any).GiDispa; win.GiLoad = (global as any).GiLoad;
    eng.GiLoad = (global as any).GiLoad; eng.Quixe = (global as any).Quixe;
    quixeEngine = eng;
    return eng;
}
function makeQuixeDriver(storyPath: string): Driver {
    const eng = quixeSetup();
    const win = eng.win;
    win._bglBP = new Set(); win._bglSeqPts = new Set();
    win._bglStepMode = false; win._bglStepStopAt = null; win._bglStepSkipAddrs = null;
    win._bglSkipPC = null; win._bglPausedPC = null; win._bglBreakPausing = false;
    let booted = false;
    return {
        kind: 'quixe',
        setBreakpoints(addrs) { win._bglBP = new Set(addrs); },
        setAllSeqPts(addrs) { win._bglSeqPts = new Set(addrs); },   // drives compile_path splitting
        run() {
            eng.stop = null;
            if (!booted) {
                booted = true;
                (global as any).location = { search: '?story=' + storyPath, toString() { return 'http://x/?story=' + storyPath; } };
                eng.GiLoad.load_run();
            }
            return eng.stop;
        },
        cont() { eng.stop = null; win._bglSkipPC = win._bglPausedPC; win._bglPausedPC = null; eng.Quixe.resume(); return eng.stop; },
        step(stopAddrs, skipAddrs) {
            const curPc = win._bglPausedPC;
            eng.stop = null;
            const skip = new Set<number>(skipAddrs ?? []);
            if (curPc != null) { skip.add(curPc); }
            win._bglSkipPC = curPc; win._bglPausedPC = null;
            win._bglStepSkipAddrs = skip.size ? skip : null;
            win._bglStepStopAt = stopAddrs && stopAddrs.length ? new Set(stopAddrs) : null;
            win._bglStepMode = true;
            if (win._bglCurrentVmFunc && win._bglCurrentIosys !== undefined) { win._bglCurrentVmFunc[win._bglCurrentIosys] = {}; }
            eng.Quixe.resume();
            return eng.stop;
        },
        getState() { return win._bglGetVmState(); },
        readWord(addr) { return win._bglReadWord(addr); },
        setLocal(stackIdx, offset, val) { return win._bglSetLocal(stackIdx, offset, val); },
    };
}

// ── authoritative stepping: drive the REAL adapter logic (computeStep + routeBreak) ──
// Mirrors exactly what the DAP adapter does in .bgl mode: compute the step plan, send it to the VM,
// then on each stop run routeBreak's stop-vs-auto-step decision — looping the auto-step cascade —
// until it says stop. So a green result exercises the SHIPPING decision code, not a copy of it.
function driveStep(d: Driver, di: DebugInfo, command: 'next' | 'stepIn' | 'stepOut', curPc: number): Stop | null {
    const loc = di.vmAddrToBgl(curPc);
    const origin = di.routineContaining(curPc);              // the routine we're stepping FROM
    // I6/library mode if we're paused at an unmapped addr (harness never opens an .inf pane).
    const stepI6 = !loc;
    const plan = computeStep({
        command, currentVmAddr: curPc,
        currentBglFile: loc?.file, currentBglLine: loc?.line,
        frames: d.getState().frames, mainInfOpen: false, di,
    });
    d.setAllSeqPts(plan.seqPts);
    let stop = d.step(plan.stopAddrs, plan.skipAddrs);
    let prevInf = di.vmAddrToInfLocation(curPc);
    for (let i = 0; i < 60 && stop; i++) {
        const action = routeBreak({
            vmAddr: stop.pc, isStep: true, frames: d.getState().frames,
            lastStepCommand: command, stepOriginRoutine: origin,
            inI6Mode: stepI6, currentInfLocation: prevInf, di,
        });
        if (action.kind === 'stop') { break; }
        prevInf = di.vmAddrToInfLocation(stop.pc);
        d.setAllSeqPts(action.seqPts);
        stop = d.step(action.stopAddrs, action.skipAddrs);
    }
    return stop;
}

// ── tests ────────────────────────────────────────────────────────────────────
/** Resolve the .bgl source file (as stored in the [map]) for a fixture whose basename we know. */
function bglFileOf(di: DebugInfo, stemHint: string): string | undefined {
    return di.allBglSourceFiles().find(f => path.basename(f).startsWith(stemHint));
}

/** Spilled-locals regression, but at RUNTIME: stop in spill, confirm a13..a18 = 13..18 from the pool. */
function zvmSpillValues(): void {
    const di = DebugInfo.load(path.join(FIX, 'spillz.bgl.bgldbg'), path.join(FIX, 'spillz.bgl.transpiled.inf.dbg'));
    const sps = routineSeqPts(path.join(FIX, 'spillz.bgl.transpiled.inf.dbg')).get('spill') ?? [];
    ok(sps.length > 0, 'zvm/spillz: found seq-points in spill');
    const bp = sps[sps.length - 1].addr;   // last seq-pt (the `return …` line, after spills assigned)

    const d = makeZvmDriver(path.join(FIX, 'spillz.z8'));
    d.setBreakpoints([bp]);
    const stop = d.run();
    ok(stop !== null && stop.pc === bp, `zvm/spillz: stopped at spill breakpoint ${bp} (got ${stop?.pc})`);

    const st = d.getState();
    const locals = st.frames[st.frames.length - 1].locals;
    const vals = Object.keys(locals).map(k => Number(k)).sort((a, b) => a - b).map(k => locals[k]);
    // frame locals: p=7, a0=7, a1..a12 = 1..12, then _bglFrm = pool base
    eq(vals[0], 7, 'zvm/spillz: local p = 7');
    eq(vals[2], 1, 'zvm/spillz: local a1 = 1');
    eq(vals[13], 12, 'zvm/spillz: local a12 = 12');
    const frm = vals[14];
    for (let i = 0; i < 6; i++) {
        eq(d.readWord(frm + i * 2), 13 + i, `zvm/spillz: spilled a${13 + i} = ${13 + i} (read from _bglFrm-->${i})`);
    }
}

// rt_calls, parametrized over both interpreters. Each scenario boots exactly ONE VM.
type Kind = 'zvm' | 'quixe';
function rtCtx(kind: Kind) {
    const base = path.join(FIX, kind === 'zvm' ? 'rt_calls_z' : 'rt_calls_g');
    const story = base + (kind === 'zvm' ? '.z8' : '.ulx');
    return {
        kind, base, story,
        di:  DebugInfo.load(base + '.bgl.bgldbg', base + '.bgl.transpiled.inf.dbg'),
        rsp: routineSeqPts(base + '.bgl.transpiled.inf.dbg'),
        allSeq: allSeqPtAddrs(base + '.bgl.transpiled.inf.dbg'),
        make: (s: string): Driver => kind === 'zvm' ? makeZvmDriver(s) : makeQuixeDriver(s),
    };
}

/** breakpoint fidelity (round-trip) + variable values: break at add's return, confirm a=5,b=3,s=8. */
function rtAddValues(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const add = rsp.get('add') ?? [];
    ok(add.length > 0, `${kind}/rt: found add seq-points`);
    const bp = add[add.length - 1].addr;                     // last seq-pt in add = the `return s` line
    const loc = di.vmAddrToBgl(bp);
    ok(!!loc, `${kind}/rt: add breakpoint resolves to a .bgl line`);
    if (loc) {
        ok(di.bglToVmAddrs(loc.file, loc.line).includes(bp),
           `${kind}/rt: round-trip bglToVmAddrs(add line) includes the breakpoint address`);
    }
    const d = make(story);
    d.setAllSeqPts(allSeq);                                  // Quixe needs paths split at seq-pts for the bp to be seen
    d.setBreakpoints([bp]);
    const stop = d.run();
    ok(stop !== null && stop.pc === bp, `${kind}/rt: stopped at add breakpoint ${bp} (got ${stop?.pc})`);
    if (!stop) { return; }
    eq(di.vmAddrToBgl(stop.pc)?.line, loc?.line, `${kind}/rt: stop line matches the requested line (fidelity)`);
    const frames = d.getState().frames;
    const locals = frames[frames.length - 1].locals;         // innermost frame = add (ZVM: single frame; Quixe: full stack)
    const v = Object.keys(locals).map(Number).sort((a, b) => a - b).map(k => locals[k]);
    eq(v[0], 5, `${kind}/rt: add param a = 5`);
    eq(v[1], 3, `${kind}/rt: add param b = 3`);
    eq(v[2], 8, `${kind}/rt: add local s = 8`);
    // Quixe's state reader exposes the full call stack — assert add is nested under a caller.
    if (kind === 'quixe') {
        ok(frames.length >= 2, `${kind}/rt: call stack has add nested under its caller (depth ${frames.length})`);
    }
}

/** step-over: from Initialise, stepping with stopAddrs=Initialise stays in Initialise (skips add/fib). */
function rtStepOver(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const init = rsp.get('Initialise') ?? [];
    ok(init.length > 0, `${kind}/rt: found Initialise seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([init[0].addr]);
    const first = d.run();
    ok(first !== null, `${kind}/rt: stopped at Initialise entry for step-over`);
    if (!first) { return; }
    const seen = new Set<number>([first.pc]);
    let cur = first.pc, stayedInInit = true;
    for (let i = 0; i < 4; i++) {
        const s = driveStep(d, di, 'next', cur);           // REAL step-over
        if (!s) { break; }
        cur = s.pc; seen.add(s.pc);
        if (di.routineContaining(s.pc)?.name !== 'Initialise') { stayedInInit = false; break; }
    }
    ok(seen.size >= 3, `${kind}/rt: step-over advanced through distinct lines (got ${seen.size})`);
    ok(stayedInInit, `${kind}/rt: step-over stayed in Initialise (did NOT descend into add/fib)`);
}

/** step-in: from Initialise, stepping with stopAddrs=[] (any seq-pt) descends into a callee. */
function rtStepIn(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const init = rsp.get('Initialise') ?? [];
    ok(init.length > 0, `${kind}/rt: found Initialise seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([init[0].addr]);
    const first = d.run();
    ok(first !== null, `${kind}/rt: stopped at Initialise entry for step-in`);
    if (!first) { return; }
    let enteredCallee = false, cur = first.pc;
    for (let i = 0; i < 8; i++) {
        const s = driveStep(d, di, 'stepIn', cur);           // REAL step-in
        if (!s) { break; }
        cur = s.pc;
        const rn = di.routineContaining(s.pc)?.name;
        if (rn === 'add' || rn === 'fib') { enteredCallee = true; break; }
    }
    ok(enteredCallee, `${kind}/rt: step-in descended into a called routine (add/fib)`);
}

/** recursion + call stack: break at fib's entry, continue, confirm n descends 6,5,4,3,2 (leftmost path). */
function rtRecursion(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const fib = rsp.get('fib') ?? [];
    ok(fib.length > 0, `${kind}/rt: found fib seq-points`);
    const entry = fib[0].addr;                               // fib's first seq-pt = the `if (n<2)` line
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([entry]);
    const readN = (): number => {
        const fr = d.getState().frames;
        const locals = fr[fr.length - 1].locals;             // innermost frame = the active fib call
        return Object.keys(locals).map(Number).sort((a, b) => a - b).map(k => locals[k])[0];
    };
    let stop = d.run();
    ok(stop !== null && di.routineContaining(stop.pc)?.name === 'fib', `${kind}/rt: broke inside fib`);
    if (!stop) { return; }
    const ns: number[] = [readN()];
    const depths: number[] = [d.getState().frames.length];
    let allInFib = true;
    for (let i = 0; i < 5; i++) {
        stop = d.cont();
        if (!stop) { break; }
        if (di.routineContaining(stop.pc)?.name !== 'fib') { allInFib = false; }
        ns.push(readN());
        depths.push(d.getState().frames.length);
    }
    // Order-independent recursion invariants (the exact trace depends on operand eval order):
    eq(ns[0], 6, `${kind}/rt: first fib call is fib(6)`);
    ok(allInFib, `${kind}/rt: every continue lands back in fib`);
    ok(ns.slice(1).every(n => n >= 0 && n < 6), `${kind}/rt: recursive calls carry smaller n (${ns.join(',')})`);
    // Quixe exposes the full stack, so recursion must nest frames several deep.
    if (kind === 'quixe') {
        ok(Math.max(...depths) >= depths[0] + 3,
           `${kind}/rt: recursion nests the call stack ≥3 deep (depths ${depths.join(',')})`);
    }
}

/** multiple breakpoints + continue: bps in add AND fib; run hits add first, continue hits fib. */
function rtMultiBreak(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const add = rsp.get('add') ?? [], fib = rsp.get('fib') ?? [];
    ok(add.length > 0 && fib.length > 0, `${kind}/rt: found add + fib seq-points`);
    const addBp = add[add.length - 1].addr, fibBp = fib[0].addr;
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([addBp, fibBp]);
    const s1 = d.run();                                      // initialise() calls add BEFORE fib
    ok(s1 !== null && di.routineContaining(s1.pc)?.name === 'add', `${kind}/rt: first breakpoint hit is in add`);
    const s2 = d.cont();
    ok(s2 !== null && di.routineContaining(s2.pc)?.name === 'fib', `${kind}/rt: continue reaches the fib breakpoint`);
}

/** set-variable: break in add, overwrite local `a`, confirm the write round-trips through the VM. */
function rtSetVar(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const add = rsp.get('add') ?? [];
    ok(add.length > 0, `${kind}/rt: found add seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([add[add.length - 1].addr]);
    const stop = d.run();
    ok(stop !== null && di.routineContaining(stop.pc)?.name === 'add', `${kind}/rt: broke in add for set-variable`);
    if (!stop) { return; }
    let fr = d.getState().frames;
    const idx = fr.length - 1;                                // innermost frame = add
    const offA = Object.keys(fr[idx].locals).map(Number).sort((a, b) => a - b)[0];  // first local = param a
    eq(fr[idx].locals[offA], 5, `${kind}/rt: local a starts at 5`);
    const wrote = d.setLocal(idx, offA, 99);
    ok(wrote, `${kind}/rt: setLocal returned true`);
    fr = d.getState().frames;
    eq(fr[fr.length - 1].locals[offA], 99, `${kind}/rt: local a reads back 99 after set-variable`);
}

/** step-out: break in add (called from Initialise), step out, land back in the caller.
 * Targets by ROUTINE (not the unreliable return PC), so it works on both interpreters —
 * including ZVM, whose state hook exposes only one frame. Also exercises the nearest
 * resolver that backs the frame-click fix. */
function rtStepOut(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const add = rsp.get('add') ?? [];
    ok(add.length > 0, `${kind}/rt: found add seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([add[add.length - 1].addr]);
    const stop = d.run();
    ok(stop !== null && di.routineContaining(stop.pc)?.name === 'add', `${kind}/rt: broke in add for step-out`);
    if (!stop) { return; }

    // Multi-frame call stack — BOTH interpreters now (ZVM walks the Z frame chain).
    const stackFrames = d.getState().frames;
    ok(stackFrames.length >= 2, `${kind}/rt: call stack has ≥2 frames (add nested under a caller; got ${stackFrames.length})`);
    ok(stackFrames.some(f => di.routineContaining(f.funcAddr)?.name === 'Initialise'),
       `${kind}/rt: Initialise appears as a caller frame in the call stack`);

    // frame-click fix (real call-site) — checked WHILE broken in add (Initialise is a live caller).
    // A caller frame's RETURN PC now points to its own call site; the hook was reading the frame
    // pointer, not the PC (per the Glulx call stub [desttype,destaddr,PC,framestart]).
    // Quixe only — ZVM's state hook exposes a single frame with returnPC=0 (routine-entry fallback).
    if (kind === 'quixe') {
        const frames = d.getState().frames;
        // stack-membership basis for step-over's entered-vs-returned distinction:
        const stackNames = new Set(frames.map(f => di.routineContaining(f.funcAddr)?.name));
        ok(stackNames.has('add') && stackNames.has('Initialise'),
           `${kind}/rt: call stack contains add AND its caller Initialise (entered-a-call state)`);
        let resolved = 0;
        for (const f of frames) {
            if (!f.returnPC) { continue; }                   // innermost frame (no call stub) — skip
            const own = di.routineContaining(f.funcAddr)?.name;
            if (!own) { continue; }
            ok(di.routineContaining(f.returnPC)?.name === own,
               `${kind}/rt: caller '${own}' return PC lands in its OWN routine's call site (got ${di.routineContaining(f.returnPC)?.name})`);
            if (di.vmAddrToBglNearest(f.returnPC)) { resolved++; }
        }
        ok(resolved > 0, `${kind}/rt: ≥1 caller frame's return PC resolved to a .bgl call site`);
        const initFrame = frames.find(f => di.routineContaining(f.funcAddr)?.name === 'Initialise' && f.returnPC);
        ok(!!initFrame, `${kind}/rt: Initialise frame present with a return PC`);
        if (initFrame) {
            ok(!!di.vmAddrToBglNearest(initFrame.returnPC),
               `${kind}/rt: Initialise's return PC resolves to a .bgl line (exact call-site click)`);
        }
    }

    // REAL step-out via computeStep+routeBreak (targets the reliable return PC).
    const out = driveStep(d, di, 'stepOut', stop.pc);
    ok(out !== null, `${kind}/rt: step-out stopped (did NOT run off the end)`);
    if (out) {
        ok(di.routineContaining(out.pc)?.name === 'Initialise',
           `${kind}/rt: step-out returned to caller Initialise (got ${di.routineContaining(out.pc)?.name})`);
        // After returning, add is POPPED — this is how onVmBreak tells "returned" from "entered a call".
        if (kind === 'quixe') {
            const after = new Set(d.getState().frames.map(f => di.routineContaining(f.funcAddr)?.name));
            ok(!after.has('add'), `${kind}/rt: after returning, add is off the stack (returned, not entered)`);
        }
    }
}

/** include-path resolution: library .inf files (parser.h, orLibrary, …) must resolve to REAL paths.
 * Regression for the `++include_path=` parse bug (single-`+`, break-after-one → none parsed → frame
 * clicks opened a non-existent output-folder path). No VM needed. */
function libPaths(): void {
    const base = path.join(FIX, 'rt_calls_g');
    const di = DebugInfo.load(base + '.bgl.bgldbg', base + '.bgl.transpiled.inf.dbg');
    const files = di.allInfSourceFiles();
    ok(files.length > 1, `libpaths: multiple .inf source files resolved (${files.length})`);
    // Check the LIBRARY files (resolved via ++include_path). The main transpiled .inf is excluded:
    // its given-path is baked as an absolute compile-time path in the .dbg, which is stale in a
    // committed fixture (points at the /tmp build dir) — a fixture artifact, not the resolution bug.
    const libFiles = files.filter(f => !f.endsWith('.bgl.transpiled.inf'));
    const missing = libFiles.filter(f => !fs.existsSync(f));
    eq(missing.length, 0, `libpaths: every library .inf resolves to a real path (missing: ${missing.map(f => path.basename(f)).join(',') || 'none'})`);
    ok(files.some(f => f.replace(/\\/g, '/').includes('/inform6/lib/') && f.endsWith('parser.h')),
       'libpaths: parser.h resolved via ++include_path (not the output-folder fallback)');
}

/** step-over (`next`) on a return into a LIBRARY caller must stop at the return point, not run off.
 * Reproduces Jim's WW3 case: Initialise is called from GamePrologue (library, unmapped) — stepping
 * next on Initialise's last line returns there. Without the return-target stop, `next` runs to the end
 * (the library caller has no .bgl line to stop on). Quixe only (ZVM state hook = single frame). */
function rtNextReturn(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const init = rsp.get('Initialise') ?? [];
    ok(init.length > 0, `${kind}/rt: found Initialise seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([init[init.length - 1].addr]);          // Initialise's last statement
    const stop = d.run();
    ok(stop !== null && di.routineContaining(stop.pc)?.name === 'Initialise', `${kind}/rt: broke at Initialise's last line`);
    if (!stop) { return; }
    const fr = d.getState().frames;
    const returnTarget = fr.length >= 2 ? fr[fr.length - 2].returnPC : 0;
    ok(returnTarget > 0, `${kind}/rt: Initialise has a return target into its caller (${returnTarget})`);
    const callerName = di.routineContaining(returnTarget)?.name;
    ok(!!callerName && callerName !== 'Initialise', `${kind}/rt: caller is a distinct (library) routine: ${callerName}`);
    ok(!di.vmAddrToBgl(returnTarget), `${kind}/rt: the library caller's return point is UNMAPPED (no .bgl line) — the case that broke`);
    // Drive the REAL adapter logic: computeStep must include the return target, routeBreak must stop.
    const out = driveStep(d, di, 'next', stop.pc);
    ok(out !== null, `${kind}/rt: next-over-return STOPPED via the real computeStep+routeBreak (did not run off)`);
    if (out) {
        ok(out.pc === returnTarget && di.routineContaining(out.pc)?.name === callerName,
           `${kind}/rt: next-over-return stopped at the caller's return point in ${callerName} (got ${di.routineContaining(out.pc)?.name})`);
    }
}

/** I6/library step-over must be ROUTINE-SCOPED (skip called functions), not stop at every seq-point.
 * That was the bug Jim hit: paused in library GamePrologue, step-over descended into the callee and
 * (finding no .bgl line ahead) ran off. Unit-tests computeStep directly on a real library routine —
 * no VM needed, so it's a reliable regression for the fix. */
function libStepOverPlan(): void {
    const base = path.join(FIX, 'rt_calls_g');
    const di  = DebugInfo.load(base + '.bgl.bgldbg', base + '.bgl.transpiled.inf.dbg');
    const rsp = routineSeqPts(base + '.bgl.transpiled.inf.dbg');
    const lib = rsp.get('obj') ?? [];                        // a library routine with many seq-points
    ok(lib.length >= 3, `libstepover: found a library routine (obj) with seq-points (${lib.length})`);
    if (lib.length < 3) { return; }
    const inside = lib[1].addr;
    const routine = di.routineContaining(inside)!;
    const retTarget = 999999;                                // synthetic caller resume address
    const plan = computeStep({
        command: 'next', currentVmAddr: inside,
        currentBglFile: undefined, currentBglLine: undefined,   // unmapped ⇒ I6/library mode
        frames: [{ funcAddr: 0, returnPC: retTarget, locals: {} }, { funcAddr: inside, returnPC: 0, locals: {} }],
        mainInfOpen: false, di,
    });
    const allN = di.allVmAddrs().length;
    ok(plan.stopAddrs.length < allN,
       `libstepover: I6-mode step-over is routine-scoped, not all ${allN} seq-points (got ${plan.stopAddrs.length})`);
    const outside = plan.stopAddrs.filter(a => a !== retTarget && !(a >= routine.startAddr && a < routine.endAddr));
    eq(outside.length, 0, `libstepover: every stop addr is inside the current routine or the return target (${outside.length} stray)`);
    ok(plan.stopAddrs.includes(retTarget), 'libstepover: return target IS a stop point (step-over of a returning line)');
}

/** input-yield: stepping past initialise into the play loop reaches glk_select (input request).
 * The step must YIELD (no step-stop) — the exact condition the webview now reports as `stepYielded`
 * so the debugger regains control instead of hanging ("stopped responding" in Jim's WW3, stepping
 * over RunAll which flows into the play loop). Reproduces the hang; the fix is the notification. */
function rtInputYield(kind: Kind): void {
    const { di, rsp, story, allSeq, make } = rtCtx(kind);
    const init = rsp.get('Initialise') ?? [];
    ok(init.length > 0, `${kind}/rt: found Initialise seq-points`);
    const d = make(story);
    d.setAllSeqPts(allSeq);
    d.setBreakpoints([init[init.length - 1].addr]);
    const stop = d.run();
    ok(stop !== null && di.routineContaining(stop.pc)?.name === 'Initialise', `${kind}/rt: broke at Initialise's last line`);
    if (!stop) { return; }
    // A fine step from here runs through initialise's return into the library play loop, which calls
    // glk_select. execute_loop exits WITHOUT a step-stop → the driver returns null (== the webview's
    // `!_bglIsPaused` after resume → stepYielded). Reproduces Jim's "step never returns" hang.
    const s = d.step(allSeq);
    ok(s === null,
       `${kind}/rt: step into the play loop YIELDS at the input request (returned ${s ? 'a stop at ' + di.routineContaining(s.pc)?.name : 'null (yield)'}) — the webview reports this as stepYielded so the debugger regains control`);
}

// ── scenario registry ────────────────────────────────────────────────────────
// Each scenario boots exactly ONE VM. Interpreter singletons (GlkOte.Glk, the Quixe
// engine) don't cleanly re-init for a second boot in the same process, so the PARENT
// runs each scenario in its own child process. A scenario may continue/step its single
// VM freely (multiple stops) — it just must not create a second VM.
const SCENARIOS: Record<string, () => void> = {
    'zvm-spill':      zvmSpillValues,
    'zvm-add':        () => rtAddValues('zvm'),
    'zvm-stepover':   () => rtStepOver('zvm'),
    'zvm-stepin':     () => rtStepIn('zvm'),
    'zvm-recursion':  () => rtRecursion('zvm'),
    'zvm-multibreak': () => rtMultiBreak('zvm'),
    'zvm-setvar':     () => rtSetVar('zvm'),
    'zvm-stepout':    () => rtStepOut('zvm'),
    'quixe-add':      () => rtAddValues('quixe'),
    'quixe-stepover': () => rtStepOver('quixe'),
    'quixe-stepin':   () => rtStepIn('quixe'),
    'quixe-recursion':  () => rtRecursion('quixe'),
    'quixe-multibreak': () => rtMultiBreak('quixe'),
    'quixe-setvar':     () => rtSetVar('quixe'),
    'quixe-stepout':    () => rtStepOut('quixe'),
    'quixe-nextreturn': () => rtNextReturn('quixe'),
    'quixe-inputyield': () => rtInputYield('quixe'),
    'libstepover':      libStepOverPlan,
    'libpaths':         libPaths,
};

function main(): void {
    const arg = process.argv.indexOf('--scenario');
    if (arg !== -1) {
        // child: run one scenario, emit structured result
        const name = process.argv[arg + 1];
        const fn = SCENARIOS[name];
        if (!fn) { console.log(`__R__ 0 1`); console.log(`__F__ unknown scenario ${name}`); process.exit(1); }
        try { fn(); } catch (e: any) { failures.push(`${name} threw: ${e?.message ?? e}`); }
        for (const f of failures) { console.log(`__F__${f}`); }
        console.log(`__R__ ${passed} ${failures.length}`);
        process.exit(failures.length ? 1 : 0);
    }

    // parent: spawn a child per scenario, aggregate
    const cp = require('child_process');
    let tPass = 0; const tFail: string[] = [];
    for (const name of Object.keys(SCENARIOS)) {
        const r = cp.spawnSync(process.execPath, [__filename, '--scenario', name], { encoding: 'utf8' });
        const lines = (r.stdout || '').split('\n');
        let sp = 0, sf = 0;
        for (const ln of lines) {
            if (ln.startsWith('__F__')) { tFail.push(ln.slice(5)); }
            else if (ln.startsWith('__R__')) { const [, p, f] = ln.split(' '); sp = +p; sf = +f; }
        }
        tPass += sp;
        const bad = sf || r.status !== 0;
        console.log(`  ${bad ? '✗' : '✓'} ${name}  (${sp} ok${sf ? `, ${sf} fail` : ''})`);
        if (r.status !== 0 && sf === 0) { tFail.push(`${name}: child exited ${r.status}${r.stderr ? ' — ' + r.stderr.trim().split('\n').pop() : ''}`); }
    }
    const total = tPass + tFail.length;
    console.log(`\nruntime harness: ${tPass}/${total} checks passed`);
    if (tFail.length) {
        console.log(`\n${tFail.length} FAILED:`);
        for (const f of tFail) { console.log(`  ✗ ${f}`); }
        process.exit(1);
    }
    console.log('all green ✓');
}

main();
