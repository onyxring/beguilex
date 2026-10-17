/**
 * beguileDebugAdapter.ts
 *
 * Implements a VS Code Debug Adapter Protocol (DAP) server inline
 * (no external process) for the Beguile language.
 *
 * BeguileDebugAdapterFactory — registered with VS Code; creates adapter instances.
 * BeguileDebugAdapter       — handles DAP protocol messages from VS Code, drives
 *                             the DebugPanel WebView, and fires DAP events back.
 */

import * as vscode from 'vscode';
import * as nodePath from 'path';
import { DebugInfo, BglLocation } from './debugInfo';
import { computeStep, routeBreak } from './debugStepLogic';

interface VmFrame  { funcAddr: number; returnPC: number; locals: { [frameOffset: number]: number } }
interface VmState  { frames: VmFrame[]; globals: { [address: number]: number } }
interface BreakpointSpec { condition?: string; hitCondition?: string; logMessage?: string; hits: number }

// ─── Module-level singletons ──────────────────────────────────────────────────

let _activeAdapter: BeguileDebugAdapter | null = null;
let _outputChannel: vscode.OutputChannel | null = null;

/** Called from extension.ts activate() to share the Beguile output channel. */
export function setBeguileOutputChannel(ch: vscode.OutputChannel): void {
    _outputChannel = ch;
}

// Debug logging to the Beguile output channel. Uncomment the body to enable.
// This is the preferred method for diagnosing debugger issues — add dbgLog()
// calls at key points, reload, reproduce, and check the Beguile output panel.
function dbgLog(_msg: string): void {
    // _outputChannel?.appendLine(`[debug] ${_msg}`);
}

/** Called by the `beguile.openI6Source` editor-title button. */
export function openI6SourceCommand(): void {
    _activeAdapter?.doOpenI6Source();
}

export function openBglSourceCommand(): void {
    _activeAdapter?.doOpenBglSource();
}

export function setActiveVarFilter(filter: string): void {
    _activeAdapter?.setVarFilter(filter);
}

/**
 * The interpreter panel handed over between debug sessions.
 *
 * A re-run stops the old session before starting the new one, which would close the
 * panel and reopen it from a remembered ViewColumn — losing any placement a column
 * cannot express, above all a detached window. Parking the live panel instead lets the
 * next launch adopt it exactly where it sits.
 */
let _parkedPanel: vscode.WebviewPanel | undefined;
let _parkedWatchers: vscode.Disposable[] = [];

function clearParkedPanel(): void {
    _parkedWatchers.forEach(d => d.dispose());
    _parkedWatchers = [];
    _parkedPanel = undefined;
}

/** Detach the running session's panel so the next launch can reuse it. */
export function parkInterpreterPanel(context: vscode.ExtensionContext): void {
    clearParkedPanel();
    const panel = _activeAdapter?.releasePanel();
    if (!panel) { return; }
    _parkedPanel = panel;
    _parkedWatchers = [
        // The user may close or move it during the handover window.
        panel.onDidDispose(() => clearParkedPanel()),
        panel.onDidChangeViewState(e => {
            if (e.webviewPanel.viewColumn !== undefined) {
                context.globalState.update('debugPanelColumn', e.webviewPanel.viewColumn);
            }
        }),
    ];
}

/** Give the running session's interpreter the keyboard (see the end of the debug launch). */
export function focusInterpreterPanel(): void {
    _activeAdapter?.focusPanel();
}

function takeParkedPanel(): vscode.WebviewPanel | undefined {
    const panel = _parkedPanel;
    clearParkedPanel();
    return panel;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class BeguileDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly context: vscode.ExtensionContext) {}

    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
        const adapter = new BeguileDebugAdapter(this.context, session.configuration);
        return new vscode.DebugAdapterInlineImplementation(adapter);
    }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class BeguileDebugAdapter implements vscode.DebugAdapter {
    private readonly _onDidSendMessage = new vscode.EventEmitter<any>();
    readonly onDidSendMessage: vscode.Event<any> = this._onDidSendMessage.event;

    private debugInfo: DebugInfo | null = null;
    private panel: any = null; // DebugPanel — use `any` to avoid circular import
    private currentVmAddr:     number | undefined;
    private currentBglFile:    string | undefined;
    private currentBglLine:    number | undefined;
    private currentInfLine:    number | undefined;
    private currentInfLocation: { path: string; line: number } | undefined;
    private currentVmState:    VmState | undefined;
    private msgSeq = 1;

    /**
     * Maps a variablesReference id (≥ 3000) to the object address + type name
     * for object-typed variables that can be expanded in the Variables pane.
     * Cleared on every resume so stale refs don't survive across steps.
     */
    private varRefMap  = new Map<number, { objAddr: number; typeName: string }>();
    /** Expandable array rows: variablesReference → the array's base pointer, element type, capacity. */
    private arrayRefMap = new Map<number, { base: number; elemType: string; capacity: number; dataOffset: number }>();
    /** Expandable member arrays held in their property's data: variablesReference → the elements read. */
    private inlineArrayMap = new Map<number, { values: number[]; elemType: string }>();
    /** The expression each expandable row stands for, so its children get an `evaluateName`. */
    private refPath = new Map<number, string>();
    private nextVarRef = 3000;

    /** Fixed variablesReference for the "Self" scope. */
    private static readonly SELF_SCOPE_REF = 3;
    /** Fixed variablesReference for the merged filter-results scope. */
    private static readonly FILTER_SCOPE_REF = 4;

    /** Current name filter applied to all variable scopes. Empty = no filter. */
    private varFilter = '';
    private lastStopReason = 'breakpoint';
    private lastStepCommand: string | undefined;
    /** Whether the in-flight step was initiated in I6/library mode (governs onVmBreak auto-step). */
    private stepInitiatedI6Mode = false;
    private stepOriginRoutine: any | undefined;  // routine at step-over start (for call-depth check)
    /**
     * Breakpoint sites, keyed by the source file VS Code set them in. Each entry maps the VM
     * addresses that line resolves to → the source line, so a break can be attributed back to the
     * exact file+line the user set the breakpoint on. `isBgl` records whether the source is a
     * .bgl (map source) or a pure-I6 file. Rebuilt per source on every setBreakpoints.
     */
    private breakpointsBySource = new Map<string, { isBgl: boolean; addrToLine: Map<number, number> }>();
    /** A breakpoint's condition, hit count and log message, by source then line. */
    private breakpointSpecs = new Map<string, Map<number, BreakpointSpec>>();
    /** The breakpoint that produced the current stop (undefined for step stops / no match). */
    private breakpointHitSource: { file: string; line: number; isBgl: boolean } | undefined;

    public setVarFilter(filter: string): void {
        this.varFilter = filter;
        // Re-sending 'stopped' (vs. 'invalidated') causes VS Code to re-fetch scopes
        // and auto-expand non-expensive ones — which is what we need for the Matches scope.
        if (this.currentVmState) {
            this.sendEvent('stopped', { reason: this.lastStopReason, threadId: 1, allThreadsStopped: true });
        } else {
            this.sendEvent('invalidated', { areas: ['variables'] });
        }
    }

    /** Decoration for the I6 line that corresponds to the current VM pause point. */
    private readonly infHighlight = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.inactiveSelectionBackground'),
        isWholeLine: true,
    });

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly config: any
    ) {
        _activeAdapter = this;
        this.context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => this.updateI6Button()),
        );
    }

    async handleMessage(message: any): Promise<void> {
        switch (message.command) {

            case 'initialize': {
                this.respond(message, {
                    supportsConfigurationDoneRequest: true,
                    supportsSetVariable: true,
                    supportsInvalidatedEvent: true,
                    supportsLoadedSourcesRequest: true,
                    supportsEvaluateForHovers: true,
                    supportsConditionalBreakpoints: true,
                    supportsHitConditionalBreakpoints: true,
                    supportsLogPoints: true,
                });
                // Do NOT send 'initialized' yet — wait until launch creates the panel,
                // so that VS Code sends setBreakpoints only after the panel exists.
                break;
            }

            case 'launch': {
                this.debugInfo = DebugInfo.load(this.config.bgldbgPath, this.config.dbgPath);
                const { DebugPanel } = await import('./debugPanel');
                const savedColumn: vscode.ViewColumn =
                    this.context.globalState.get('debugPanelColumn', vscode.ViewColumn.Beside);
                this.panel = DebugPanel.createForAdapter(
                    this.context,
                    this.config.storyPath,
                    this.config.isZMachine ?? false,
                    savedColumn,
                    (addr: number, vmState: VmState) => this.onVmBreak(addr, false, vmState),
                    (addr: number, vmState: VmState) => this.onVmBreak(addr, true, vmState),
                    (col) => this.onPanelClosed(col),
                    takeParkedPanel()
                );
                // A step ran into an input request (glk_select) or quit — the VM yielded without a
                // step boundary. Regain control so the debugger doesn't hang: surface it as stopped
                // (the game is waiting for input; the user can Continue to play, or step again).
                this.panel.onStepYielded = () => {
                    this.lastStopReason = 'step';
                    this.sendEvent('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true,
                        description: 'Program is waiting for input — press Continue to play, or step again.' });
                };
                // Mirror game text output to the Debug Console in real-time
                this.panel.onDebugOutput = (text: string) => {
                    if (vscode.workspace.getConfiguration('Beguilex').get<boolean>('debugConsoleOutput')) {
                        this.sendEvent('output', { category: 'stdout', output: text });
                    }
                };
                this.respond(message, {});
                // Announce all source files (.bgl and .inf) so VS Code enables
                // breakpoints in included/generated files without opening them first.
                for (const f of this.debugInfo.allBglSourceFiles()) {
                        this.sendEvent('loadedSource', { reason: 'new', source: { path: f, name: nodePath.basename(f) } });
                }
                for (const f of this.debugInfo.allInfSourceFiles()) {
                    this.sendEvent('loadedSource', { reason: 'new', source: { path: f, name: nodePath.basename(f) } });
                }
                // Send 'initialized' now that the panel exists, so VS Code sends
                // setBreakpoints while panel is ready to receive them.
                this.sendEvent('initialized');
                break;
            }

            case 'loadedSources': {
                const sources = (this.debugInfo?.allBglSourceFiles() ?? [])
                    .map(f => ({ path: f, name: nodePath.basename(f) }));
                for (const f of (this.debugInfo?.allInfSourceFiles() ?? [])) {
                    sources.push({ path: f, name: nodePath.basename(f) });
                }
                this.respond(message, { sources });
                break;
            }

            case 'setBreakpoints': {
                const src = message.arguments?.source?.path ?? '';
                const bps = (message.arguments?.breakpoints ?? []) as Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }>;
                const specs = new Map<number, BreakpointSpec>();
                for (const bp of bps) {
                    if (bp.condition || bp.hitCondition || bp.logMessage) {
                        specs.set(bp.line, { condition: bp.condition?.trim() || undefined, hitCondition: bp.hitCondition?.trim() || undefined,
                                             logMessage: bp.logMessage, hits: 0 });
                    }
                }
                if (specs.size > 0) { this.breakpointSpecs.set(src, specs); } else { this.breakpointSpecs.delete(src); }

                dbgLog(`setBreakpoints: src=${src} bps=${JSON.stringify(bps.map(b=>b.line))} hasDebugInfo=${!!this.debugInfo}`);
                // Route by .bgldbg map membership rather than file extension. A .inf
                // file in .inf-as-input mode appears in the map's bglFile column the
                // same way a .bgl file does, so both go through the bgl→VM lookup.
                // Pure I6 sources (the transpiled .inf, parser.h, verblib.h, etc.)
                // fall through to the I6 line→VM lookup.
                if (this.debugInfo && this.debugInfo.isBglSource(src)) {
                    const verified: Array<{ verified: boolean; line: number; message?: string }> = [];
                    const addrs = new Set<number>();
                    const addrToLine = new Map<number, number>();

                    for (const bp of bps) {
                        const vmAddrs = this.debugInfo.bglToVmAddrs(src, bp.line);
                        dbgLog(`  line ${bp.line} → vmAddrs=[${vmAddrs.map(a=>'0x'+a.toString(16)).join(',')}]`);
                        if (vmAddrs.length > 0) {
                            verified.push({ verified: true, line: bp.line });
                            for (const a of vmAddrs) { addrs.add(a); addrToLine.set(a, bp.line); }
                        } else {
                            verified.push({ verified: false, line: bp.line, message: 'No code at this line' });
                        }
                    }

                    this.recordBreakpointSites(src, true, addrToLine);
                    dbgLog(`  → updateBreakpoints with ${addrs.size} addrs`);
                    this.panel?.updateBreakpoints(src, addrs);
                    this.respond(message, { breakpoints: verified });
                } else if (this.debugInfo) {
                    // Pure I6 source breakpoints — map I6 line → VM addresses via addrToInf
                    const verified: Array<{ verified: boolean; line: number; message?: string }> = [];
                    const addrs = new Set<number>();
                    const addrToLine = new Map<number, number>();

                    for (const bp of bps) {
                        const vmAddrs = this.debugInfo.vmAddrsForInfLine(bp.line, src);
                        if (vmAddrs.length > 0) {
                            verified.push({ verified: true, line: bp.line });
                            for (const a of vmAddrs) { addrs.add(a); addrToLine.set(a, bp.line); }
                        } else {
                            verified.push({ verified: false, line: bp.line, message: 'No code at this line' });
                        }
                    }

                    this.recordBreakpointSites(src, false, addrToLine);
                    this.panel?.updateBreakpoints(src, addrs);
                    this.respond(message, { breakpoints: verified });
                } else {
                    this.respond(message, { breakpoints: bps.map(() => ({ verified: false })) });
                }
                break;
            }

            case 'configurationDone': {
                const globalAddrs = this.debugInfo?.globals().map(g => g.address) ?? [];
                this.panel?.startGame(globalAddrs);
                this.respond(message, {});
                break;
            }

            case 'threads': {
                this.respond(message, { threads: [{ id: 1, name: 'Game' }] });
                break;
            }

            case 'stackTrace': {
                const frames: any[] = [];
                const vmFrames = this.currentVmState?.frames ?? [];
                const isDocOpen = (p: string) =>
                    vscode.workspace.textDocuments.some(d => d.uri.fsPath === p);
                const bglOpen = (file: string) => isDocOpen(file);

                // ── resolveSource — stack frame source priority ─────────────
                // Determines which file VS Code navigates to for each stack frame.
                // Priority (top frame in I6 mode):
                //   1. infLoc — keeps focus on .inf file during I6 stepping
                // Priority (all other cases):
                //   1. bglLoc if file is open — prefer .bgl when user has it visible
                //   2. infLoc if file is open — show .inf when .bgl is closed
                //   3. bglLoc (not open) — fallback opens .bgl
                //   4. infLoc (not open) — last resort (e.g. stepIn to new .inf file)
                //
                // Without the I6 mode override, VS Code would always navigate to
                // .bgl when both .bgl and .inf are open (since .bgl is checked first).
                // This caused the "focus reverts to .bgl pane" bug during I6 stepping.
                const mainInfPath = this.config?.infPath;
                const infSources = this.debugInfo?.allInfSourceFiles() ?? [];
                // I6 mode for SOURCE NAVIGATION — decides whether a frame navigates to the .inf
                // instead of the .bgl. Gate it on the ACTIVE editor, not merely a visible one:
                // opening the transpiled .inf in another pane must NOT hijack a breakpoint that
                // was set in a .bgl file (Jim: "stop on the file which has the breakpoint; don't
                // open an .inf unless the active debugging window is also .inf").
                //   (a) no .bgl mapping (pure library/I6 code) → must show .inf, there's no .bgl.
                //   (b) the active editor IS an .inf source → the user is looking at I6.
                //   (c) this stop is a STEP that began in I6 mode → keep .inf focus through I6
                //       stepping even if the active editor momentarily isn't the .inf pane.
                const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
                const activeIsInf = !!activePath &&
                    (activePath === mainInfPath || infSources.includes(activePath));
                const i6Mode = (!!this.currentInfLocation && !this.currentBglFile)
                    || activeIsInf
                    || (this.lastStopReason === 'step' && this.stepInitiatedI6Mode);
                const resolveSource = (
                    bglLoc: BglLocation | undefined,
                    infLoc: { path: string; line: number } | undefined,
                    isTopFrame = false
                ) => {
                    // A breakpoint stop lands on the file the breakpoint was set in — even when an
                    // .inf pane is the active editor. The breakpoint's own source wins over i6Mode.
                    if (isTopFrame && this.breakpointHitSource) {
                        const bp = this.breakpointHitSource;
                        if (bp.isBgl && bglLoc) {
                            return { source: { path: bglLoc.file, name: nodePath.basename(bglLoc.file) }, line: bglLoc.line };
                        }
                        if (!bp.isBgl && infLoc) {
                            return { source: { path: infLoc.path, name: nodePath.basename(infLoc.path) }, line: infLoc.line };
                        }
                        return { source: { path: bp.file, name: nodePath.basename(bp.file) }, line: bp.line };
                    }
                    if (isTopFrame && i6Mode && infLoc) {
                        return { source: { path: infLoc.path, name: nodePath.basename(infLoc.path) }, line: infLoc.line };
                    }
                    if (bglLoc && bglOpen(bglLoc.file)) {
                        return { source: { path: bglLoc.file, name: nodePath.basename(bglLoc.file) }, line: bglLoc.line };
                    }
                    if (infLoc && isDocOpen(infLoc.path)) {
                        return { source: { path: infLoc.path, name: nodePath.basename(infLoc.path) }, line: infLoc.line };
                    }
                    if (bglLoc) {
                        return { source: { path: bglLoc.file, name: nodePath.basename(bglLoc.file) }, line: bglLoc.line };
                    }
                    if (infLoc) {
                        return { source: { path: infLoc.path, name: nodePath.basename(infLoc.path) }, line: infLoc.line };
                    }
                    return null;
                };

                // vmFrames is ordered bottom→top; display top→bottom (innermost first)
                for (let i = vmFrames.length - 1; i >= 0; i--) {
                    const vmf     = vmFrames[i];
                    const frameId = vmFrames.length - 1 - i; // 0 = innermost
                    // Quixe sets funcAddr = routine start; ZVM sets it = current pc — so fall back
                    // to routineContaining, or the frame name shows as a hex address on ZVM.
                    const routine = this.debugInfo?.routineByAddr(vmf.funcAddr)
                                 ?? this.debugInfo?.routineContaining(vmf.funcAddr);
                    const name    = routine?.name ?? `0x${vmf.funcAddr.toString(16)}`;

                    let bglLoc: BglLocation | undefined;
                    let infLoc: { path: string; line: number } | undefined;
                    if (frameId === 0) {
                        if (this.currentBglFile && this.currentBglLine !== undefined) {
                            bglLoc = { file: this.currentBglFile, line: this.currentBglLine };
                        }
                        infLoc = this.currentInfLocation;
                    } else if (this.debugInfo) {
                        // Prefer the EXACT call site: the frame's return PC (now read correctly from
                        // the Glulx call stub) resolved to its nearest mapped line. `vmAddrToBglNearest`
                        // is bounded to the containing routine and returns nothing for a bogus PC, so a
                        // bad value can't send the click to the wrong file. Fall back to the routine's
                        // entry line (from the reliable funcAddr) when there's no usable return PC —
                        // e.g. ZVM, whose state hook exposes returnPC=0.
                        if (vmf.returnPC) {
                            bglLoc = this.debugInfo.vmAddrToBglNearest(vmf.returnPC);
                            infLoc = this.debugInfo.vmAddrToInfLocation(vmf.returnPC);
                        }
                        if (!bglLoc && !infLoc && vmf.funcAddr) {
                            const entry = this.debugInfo.routineEntryAddr(vmf.funcAddr);
                            if (entry !== undefined) {
                                bglLoc = this.debugInfo.vmAddrToBgl(entry);
                                infLoc = this.debugInfo.vmAddrToInfLocation(entry);
                            }
                        }
                    }

                    const src = resolveSource(bglLoc, infLoc, frameId === 0);
                    if (src) {
                        frames.push({ id: frameId, name, ...src, column: 1 });
                    } else {
                        frames.push({ id: frameId, name, line: 0, column: 0 });
                    }
                }
                if (frames.length === 0 && this.currentBglFile && this.currentBglLine !== undefined) {
                    const src = resolveSource(
                        { file: this.currentBglFile, line: this.currentBglLine },
                        this.currentInfLocation,
                        true
                    );
                    if (src) {
                        frames.push({ id: 0, name: 'Beguile', ...src, column: 1 });
                    }
                }
                this.respond(message, { stackFrames: frames, totalFrames: frames.length });
                break;
            }

            case 'scopes': {
                const frameId = message.arguments?.frameId ?? 0;
                if (this.varFilter) {
                    this.respond(message, { scopes: [
                        { name: `Matches: "${this.varFilter}"`, variablesReference: BeguileDebugAdapter.FILTER_SCOPE_REF, expensive: false }
                    ]});
                    break;
                }
                const scopes: any[] = [
                    { name: 'Locals', variablesReference: 1000 + frameId, expensive: false },
                ];
                // Add a Self scope when paused inside a method (self holds a known object)
                const selfAddr = this.debugInfo?.selfAddress();
                if (selfAddr !== undefined && this.currentVmState) {
                    const selfObjAddr = this.currentVmState.globals[selfAddr] ?? 0;
                    const objName = selfObjAddr ? this.debugInfo?.objectByAddr(selfObjAddr) : undefined;
                    if (objName && this.debugInfo?.objectTypeInfoFor(objName)) {
                        scopes.push({ name: `Self (${objName})`, variablesReference: BeguileDebugAdapter.SELF_SCOPE_REF, expensive: false });
                    }
                }
                scopes.push({ name: 'Globals', variablesReference: 2, expensive: false });
                this.respond(message, { scopes });
                break;
            }

            case 'variables': {
                const ref  = message.arguments?.variablesReference ?? 0;
                const vars: any[] = [];
                const f = this.varFilter.toLowerCase();

                if (ref === BeguileDebugAdapter.FILTER_SCOPE_REF) {
                    // ── Merged results from all scopes (filter active) ────────
                    // Locals from top frame
                    const vmFrames = this.currentVmState?.frames ?? [];
                    const vmFrame  = vmFrames.length > 0 ? vmFrames[vmFrames.length - 1] : undefined;
                    if (vmFrame && this.debugInfo) {
                        const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
                                     ?? (this.currentVmAddr !== undefined
                                         ? this.debugInfo.routineContaining(this.currentVmAddr)
                                         : undefined);
                        const localsByOffset = new Map(routine?.locals.map(l => [l.frameOffset, l.name]) ?? []);
                        const localVars = await Promise.all(
                            Object.entries(vmFrame.locals).map(([offsetStr, value]) => {
                                const offset = Number(offsetStr);
                                const name   = localsByOffset.get(offset) ?? `local_${offset}`;
                                const type   = routine ? this.debugInfo!.localVarType(routine.startAddr, name) : undefined;
                                return this.makeVarAsync(name, value as number, type);
                            })
                        );
                        vars.push(...localVars.filter(v => !f || v.name.toLowerCase().includes(f)));
                        const spilledF = await this.buildSpilledLocals(routine, vmFrame);
                        vars.push(...spilledF.filter(v => !f || v.name.toLowerCase().includes(f)));
                    }
                    // Self props
                    const selfAddrF = this.debugInfo?.selfAddress();
                    if (selfAddrF !== undefined && this.currentVmState && this.debugInfo && this.panel) {
                        const selfObjAddr = this.currentVmState.globals[selfAddrF] ?? 0;
                        const objName  = selfObjAddr ? this.debugInfo.objectByAddr(selfObjAddr) : undefined;
                        const typeInfo = objName ? this.debugInfo.objectTypeInfoFor(objName) : undefined;
                        if (typeInfo && selfObjAddr) {
                            const reads = await Promise.all(typeInfo.props.map(p => this.expandPropAsync(p, selfObjAddr)));
                            for (const v of reads) {
                                if (!f || v.name.toLowerCase().includes(f)) { vars.push(v); }
                            }
                        }
                    }
                    // Globals
                    const globalVals = this.currentVmState?.globals ?? {};
                    const scalarVarsF = await Promise.all(
                        (this.debugInfo?.userGlobals() ?? []).map(g => {
                            const raw  = globalVals[g.address] ?? 0;
                            const type = this.debugInfo?.globalVarType(g.name);
                            return this.makeVarAsync(g.name, raw, type);
                        })
                    );
                    vars.push(...scalarVarsF.filter(v => !f || v.name.toLowerCase().includes(f)));
                    for (const g of (this.debugInfo?.userGlobalArrays() ?? [])) {
                        if (f && !g.name.toLowerCase().includes(f)) { continue; }
                        vars.push(await this.makeVarAsync(g.name, g.address, this.debugInfo?.globalVarType(g.name)));
                    }
                    for (const g of (this.debugInfo?.userGlobalObjects() ?? [])) {
                        if (f && !g.name.toLowerCase().includes(f)) { continue; }
                        vars.push(this.makeVar(g.name, g.address, this.debugInfo?.globalVarType(g.name)));
                    }

                } else if (ref === BeguileDebugAdapter.SELF_SCOPE_REF) {
                    // ── Self (current method receiver) ────────────────────────
                    const selfAddr = this.debugInfo?.selfAddress();
                    if (selfAddr !== undefined && this.currentVmState && this.debugInfo && this.panel) {
                        const selfObjAddr = this.currentVmState.globals[selfAddr] ?? 0;
                        const objName  = selfObjAddr ? this.debugInfo.objectByAddr(selfObjAddr) : undefined;
                        const typeInfo = objName ? this.debugInfo.objectTypeInfoFor(objName) : undefined;
                        if (typeInfo && selfObjAddr) {
                            const reads = await Promise.all(
                                typeInfo.props.map(p => this.expandPropAsync(p, selfObjAddr))
                            );
                            for (const v of reads) { vars.push(v); }
                        }
                    }

                } else if (ref === 2) {
                    // ── Globals ───────────────────────────────────────────────
                    const globalVals = this.currentVmState?.globals ?? {};
                    // Scalar globals: address is a global-variable slot; read live value from VM state
                    const scalarVars = await Promise.all(
                        (this.debugInfo?.userGlobals() ?? []).map(g => {
                            const raw  = globalVals[g.address] ?? 0;
                            const type = this.debugInfo?.globalVarType(g.name);
                            return this.makeVarAsync(g.name, raw, type);
                        })
                    );
                    vars.push(...scalarVars.filter(v => !f || v.name.toLowerCase().includes(f)));
                    // File-scope arrays: the address is the array itself.
                    for (const g of (this.debugInfo?.userGlobalArrays() ?? [])) {
                        if (f && !g.name.toLowerCase().includes(f)) { continue; }
                        vars.push(await this.makeVarAsync(g.name, g.address, this.debugInfo?.globalVarType(g.name)));
                    }
                    // Object globals: address is the fixed Glulx object address; value IS the address
                    for (const g of (this.debugInfo?.userGlobalObjects() ?? [])) {
                        if (f && !g.name.toLowerCase().includes(f)) { continue; }
                        const typeInfo = this.debugInfo?.objectTypeInfoFor(g.name);
                        if (typeInfo) {
                            const varRef = this.nextVarRef++;
                            this.varRefMap.set(varRef, { objAddr: g.address, typeName: typeInfo.name });
                            vars.push({ name: g.name, value: typeInfo.name, type: typeInfo.name, variablesReference: varRef });
                        } else {
                            // No expandable properties — show object name, not raw address
                            vars.push({ name: g.name, value: g.name, type: 'object', variablesReference: 0 });
                        }
                    }

                } else if (this.inlineArrayMap.has(ref)) {
                    // ── Member array held in its property's data ─────────────
                    const info = this.inlineArrayMap.get(ref)!;
                    for (let i = 0; i < info.values.length; i++) {
                        vars.push(await this.makeVarAsync(`[${i}]`, info.values[i], info.elemType));
                    }

                } else if (this.arrayRefMap.has(ref)) {
                    // ── Array element expansion ───────────────────────────────
                    const info = this.arrayRefMap.get(ref)!;
                    if (this.panel) {
                        const WORDSIZE = this.config?.isZMachine ? 2 : 4;
                        for (let i = 0; i < info.capacity; i++) {
                            // dataOffset: 0 for a flat rawArray (data from word 0), 1 for a tracked/
                            // plain array (word 0 is the header/count).
                            const raw = (await this.panel.readWord(info.base + (i + info.dataOffset) * WORDSIZE)) ?? 0;
                            vars.push(await this.makeVarAsync(`[${i}]`, raw, info.elemType));
                        }
                    }

                } else if (ref >= 3000) {
                    // ── Object property expansion ─────────────────────────────
                    const entry = this.varRefMap.get(ref);
                    if (entry && this.debugInfo && this.panel) {
                        const typeInfo = this.debugInfo.objectTypeInfoFor(entry.typeName)
                                      ?? this.debugInfo.typeInfo(entry.typeName);
                        if (typeInfo) {
                            const reads = await Promise.all(
                                typeInfo.props.map(p => this.expandPropAsync(p, entry.objAddr))
                            );
                            for (const v of reads) { vars.push(v); }
                        }
                    }

                } else if (ref >= 1000) {
                    // ── Locals for a specific frame ───────────────────────────
                    const frameDepth = ref - 1000;
                    const vmFrames   = this.currentVmState?.frames ?? [];
                    const frameIdx   = vmFrames.length - 1 - frameDepth;
                    const vmFrame    = frameIdx >= 0 ? vmFrames[frameIdx] : undefined;

                    if (vmFrame && this.debugInfo) {
                        // ZVM reports a frame's current pc rather than its routine's start.
                        const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
                                     ?? this.debugInfo.routineContaining(vmFrame.funcAddr)
                                     ?? (frameDepth === 0 && this.currentVmAddr !== undefined
                                         ? this.debugInfo.routineContaining(this.currentVmAddr)
                                         : undefined);
                        const localsByOffset = new Map(
                            routine?.locals.map(l => [l.frameOffset, l.name]) ?? []
                        );
                        const localVars = await Promise.all(
                            Object.entries(vmFrame.locals).map(([offsetStr, value]) => {
                                const offset = Number(offsetStr);
                                const name   = localsByOffset.get(offset) ?? `local_${offset}`;
                                const type   = routine
                                    ? this.debugInfo!.localVarType(routine.startAddr, name)
                                    : undefined;
                                return this.makeVarAsync(name, value as number, type);
                            })
                        );
                        vars.push(...localVars.filter(v => !f || v.name.toLowerCase().includes(f)));
                        const spilled = await this.buildSpilledLocals(routine, vmFrame);
                        vars.push(...spilled.filter(v => !f || v.name.toLowerCase().includes(f)));
                    }
                }

                if (vars.length === 0 && ref === BeguileDebugAdapter.FILTER_SCOPE_REF) {
                    vars.push({ name: 'No matches.', value: '', variablesReference: 0 });
                } else if (!this.arrayRefMap.has(ref) && !this.inlineArrayMap.has(ref)) {
                    // Keep array elements in index order ([0],[1],…,[10]); only sort named scopes.
                    vars.sort((a, b) => a.name.localeCompare(b.name));
                }
                // An `evaluateName` lets "Add to Watch" and "Copy as Expression" work on any row.
                const parent = this.refPath.get(ref) ?? '';
                for (const v of vars) {
                    if (!v.name || v.name === 'No matches.') { continue; }
                    v.evaluateName = !parent ? v.name : v.name.startsWith('[') ? parent + v.name : `${parent}.${v.name}`;
                    if (v.variablesReference) { this.refPath.set(v.variablesReference, v.evaluateName); }
                }
                this.respond(message, { variables: vars });
                break;
            }

            case 'evaluate': {
                const expr     = (message.arguments?.expression ?? '').trim();
                const frameId2 = message.arguments?.frameId ?? 0;
                // Resolve the expression to a value + its Beguile type, then render it the same way the
                // Variables pane does, so Watch and hover get the same formatting and expansion.
                const r = await this.resolveExpression(expr, frameId2);
                if (r === undefined) {
                    this.respond(message, {}, `Can't evaluate: ${expr}`);
                } else {
                    const v = r.words ? this.makeInlineArrayVar(expr, r.words, r.type ?? 'array<int>')
                                      : await this.makeVarAsync(expr, r.raw, r.type);
                    if (v.variablesReference) { this.refPath.set(v.variablesReference, expr); }
                    this.respond(message, { result: v.value, type: v.type, variablesReference: v.variablesReference ?? 0 });
                }
                break;
            }

            case 'setVariable': {
                const ref     = message.arguments?.variablesReference ?? 0;
                const name    = (message.arguments?.name ?? '') as string;
                const strVal  = (message.arguments?.value ?? '') as string;

                // Parse the incoming value: bool keywords, a char literal ('q'), hex, decimal, or the
                // text the pane shows for it ("green (2)", "'q' (113)").
                let numVal: number;
                const sv = strVal.trim();
                const shownNumber = /\((-?\d+)\)\s*$/.exec(sv);
                if      (sv === 'true')  { numVal = 1; }
                else if (sv === 'false') { numVal = 0; }
                else if (/^'.'$/.test(sv)) { numVal = sv.charCodeAt(1); }
                else if (/^-?0x[0-9a-f]+$/i.test(sv)) { numVal = parseInt(sv, 16); }
                else if (/^-?\d+$/.test(sv)) { numVal = parseInt(sv, 10); }
                else if (shownNumber) { numVal = parseInt(shownNumber[1], 10); }
                else { this.respond(message, {}, `Invalid value: ${strVal}`); break; }

                if (ref === 2 && this.debugInfo && this.panel) {
                    // ── Global variable ───────────────────────────────────────
                    const g = this.debugInfo.globals().find(g => g.name === name);
                    if (!g) { this.respond(message, {}, `Unknown global: ${name}`); break; }
                    const type = this.debugInfo.globalVarType(name);
                    if (!this.isSettable(type)) {
                        this.respond(message, {}, 'Only int, bool, char and enum globals can be set');
                        break;
                    }
                    const ok = await this.panel.setGlobal(g.address, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    // Keep the cached state in sync so the Variables pane reflects the change immediately.
                    if (this.currentVmState) { this.currentVmState.globals[g.address] = numVal; }
                    this.respond(message, { value: this.makeVar(name, numVal, type).value, type });

                } else if (ref === BeguileDebugAdapter.SELF_SCOPE_REF && this.debugInfo && this.panel && this.currentVmState) {
                    // ── Self property ─────────────────────────────────────────
                    const selfAddr    = this.debugInfo.selfAddress();
                    const selfObjAddr = selfAddr ? (this.currentVmState.globals[selfAddr] ?? 0) : 0;
                    const objName     = selfObjAddr ? this.debugInfo.objectByAddr(selfObjAddr) : undefined;
                    const typeName    = objName ? (this.debugInfo.globalVarType(objName) ?? objName) : undefined;
                    const typeInfo    = typeName ? this.debugInfo.typeInfo(typeName) : undefined;
                    const prop        = typeInfo?.props.find(p => p.bglName === name);
                    if (!prop || !selfObjAddr) { this.respond(message, {}, 'Unknown property or no current object'); break; }
                    if (!this.isSettable(prop.type)) { this.respond(message, {}, 'Only int, bool, char and enum properties can be set'); break; }
                    const propId = this.debugInfo.propNumber(prop.i6Name);
                    if (propId === undefined) { this.respond(message, {}, `Property number unknown for: ${prop.i6Name}`); break; }
                    const ok = await this.panel.setProp(selfObjAddr, propId, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    this.respond(message, { value: this.makeVar(name, numVal, prop.type).value, type: prop.type });

                } else if (this.varRefMap.has(ref) && this.debugInfo && this.panel) {
                    // ── Object property ───────────────────────────────────────
                    const entry = this.varRefMap.get(ref)!;
                    const typeInfo = this.debugInfo.typeInfo(entry.typeName);
                    const prop = typeInfo?.props.find(p => p.bglName === name);
                    if (!prop) { this.respond(message, {}, `Unknown property: ${name}`); break; }
                    if (!this.isSettable(prop.type)) {
                        this.respond(message, {}, 'Only int, bool, char and enum properties can be set');
                        break;
                    }
                    const propId = this.debugInfo.propNumber(prop.i6Name);
                    if (propId === undefined) { this.respond(message, {}, `Property number unknown for: ${prop.i6Name}`); break; }
                    const ok = await this.panel.setProp(entry.objAddr, propId, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    this.respond(message, { value: this.makeVar(name, numVal, prop.type).value, type: prop.type });

                } else if (ref >= 1000 && !this.varRefMap.has(ref) && this.debugInfo && this.panel && this.currentVmState) {
                    // ── Local variable ────────────────────────────────────────
                    const frameDepth = ref - 1000;
                    const vmFrames   = this.currentVmState.frames;
                    // vmFrames[0]=outermost, vmFrames[length-1]=innermost; frameDepth 0=innermost
                    const vmFrame    = vmFrames[vmFrames.length - 1 - frameDepth];
                    if (!vmFrame) { this.respond(message, {}, 'Invalid frame'); break; }

                    const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
                                 ?? this.debugInfo.routineContaining(vmFrame.funcAddr)
                                 ?? (frameDepth === 0 && this.currentVmAddr !== undefined
                                     ? this.debugInfo.routineContaining(this.currentVmAddr)
                                     : undefined);
                    const local = routine?.locals.find(l => l.name === name);
                    if (!local) { this.respond(message, {}, `Unknown local: ${name}`); break; }

                    const type = routine
                        ? this.debugInfo.localVarType(routine.startAddr, name)
                        : undefined;
                    if (type !== undefined && !this.isSettable(type)) {
                        this.respond(message, {}, 'Only int, bool, char and enum locals can be set');
                        break;
                    }
                    // stackIdx: Quixe stack is also ordered outermost→innermost,
                    // so the frame at frameDepth d is at stack index length-1-d.
                    const stackIdx = vmFrames.length - 1 - frameDepth;
                    const ok = await this.panel.setLocal(stackIdx, local.frameOffset, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    // Update cached state so Variables pane is immediately consistent.
                    vmFrame.locals[local.frameOffset] = numVal;
                    this.respond(message, { value: this.makeVar(name, numVal, type).value, type: type ?? 'int' });

                } else {
                    this.respond(message, {}, 'Cannot set variable in this scope');
                }
                break;
            }

            case 'continue': {
                this.clearInfHighlight();
                this.hideI6Button();
                this.varRefMap.clear();
                this.arrayRefMap.clear();
                this.inlineArrayMap.clear();
                this.refPath.clear();
                dbgLog(`continue → addr 0x${(this.currentVmAddr ?? 0).toString(16)}`);
                this.panel?.sendContinue();
                this.respond(message, { allThreadsContinued: true });
                break;
            }

            // ── Step handler ─────────────────────────────────────────────
            // Stepping operates in two modes determined by I6 mode detection:
            //
            // 1. COARSE (.bgl mode) — main .inf is NOT visible and we're at a
            //    .bgl-mapped address.  stopAddrs = allMappedVmAddrs() so the VM
            //    only stops at addresses with .bgl mappings.  Unmapped addresses
            //    (library code between .bgl lines) are auto-stepped in onVmBreak.
            //
            // 2. FINE (I6 mode) — main .inf IS visible OR we're paused at an
            //    .inf-only address.  Behavior depends on the DAP command:
            //    - next:    stopAddrs = same .inf file only (skips called functions)
            //    - stepIn:  stopAddrs = all sequence points (enters calls)
            //    - stepOut: stopAddrs = all EXCEPT current file (stops at caller)
            //    The "same file" filter only applies when atInfOnly (paused in
            //    parser.h etc.), not when stepping from .bgl into .inf.
            //
            // skipAddrs = addresses on the CURRENT line (so we advance past them).
            // seqPts = all sequence points (sent to JIT block splitter).
            case 'next':
            case 'stepIn':
            case 'stepOut': {
                this.clearInfHighlight();
                this.hideI6Button();
                this.varRefMap.clear();
                this.arrayRefMap.clear();
                this.inlineArrayMap.clear();
                this.refPath.clear();
                this.lastStepCommand = message.command;
                // Save the routine we're stepping FROM so step-over can detect calls
                this.stepOriginRoutine = this.currentVmAddr !== undefined
                    ? this.debugInfo?.routineContaining(this.currentVmAddr) : undefined;

                let plan = { skipAddrs: [] as number[], stopAddrs: [] as number[], seqPts: [] as number[] };
                if (this.debugInfo) {
                    const mainInfOpen = vscode.window.visibleTextEditors.some(
                        e => e.document.uri.fsPath === this.config.infPath
                    );
                    // Remember whether THIS step was initiated in I6/library mode — onVmBreak uses it
                    // to decide whether to auto-step past unmapped addrs (.bgl mode) or stop on the
                    // .inf line (I6 mode). It must reflect the step's origin, not break-time editor state.
                    const stepInfLoc = this.currentVmAddr !== undefined
                        ? this.debugInfo.vmAddrToInfLocation(this.currentVmAddr) : undefined;
                    this.stepInitiatedI6Mode = mainInfOpen || (!!stepInfLoc && !this.currentBglFile);
                    plan = computeStep({
                        command: message.command as 'next' | 'stepIn' | 'stepOut',
                        currentVmAddr:  this.currentVmAddr,
                        currentBglFile: this.currentBglFile,
                        currentBglLine: this.currentBglLine,
                        frames: this.currentVmState?.frames ?? [],
                        mainInfOpen,
                        di: this.debugInfo,
                    });
                }
                this.panel?.sendStep(plan.skipAddrs, plan.stopAddrs, plan.seqPts);
                this.respond(message, {});
                break;
            }

            case 'pause': {
                this.respond(message, {});
                break;
            }

            case 'disconnect':
            case 'terminate': {
                this.clearInfHighlight();
                this.hideI6Button();
                this.panel?.dispose();
                this.respond(message, {});
                this.sendEvent('terminated');
                break;
            }

            default: {
                // Unknown command — send an empty success response to avoid hanging
                this.respond(message, {});
                break;
            }
        }
    }

    /** Replace the breakpoint sites for `src` (empty set clears the source). */
    private recordBreakpointSites(src: string, isBgl: boolean, addrToLine: Map<number, number>): void {
        if (addrToLine.size === 0) { this.breakpointsBySource.delete(src); return; }
        this.breakpointsBySource.set(src, { isBgl, addrToLine });
    }

    /** Find the breakpoint (file+line) whose resolved addresses include `vmAddr`, if any. */
    private lookupBreakpointSite(vmAddr: number): { file: string; line: number; isBgl: boolean } | undefined {
        for (const [file, info] of this.breakpointsBySource) {
            const line = info.addrToLine.get(vmAddr);
            if (line !== undefined) { return { file, line, isBgl: info.isBgl }; }
        }
        return undefined;
    }

    // ── onVmBreak — auto-step cascade ─────────────────────────────
    // Called when the VM stops at a breakpoint or step boundary.
    //
    // Auto-step logic (isStep && no .bgl mapping):
    //   In .bgl mode, many VM addresses between .bgl lines have no mapping
    //   (they're I6 library code). When the VM stops at one, we immediately
    //   fire another step to skip past it (auto-step cascade). This continues
    //   until we land on a .bgl-mapped address.
    //
    //   Auto-step is BYPASSED when:
    //   - We're in I6 mode (main .inf or current .inf file is visible)
    //   - The last command was stepIn or stepOut (user explicitly wants to
    //     see the target even if its file isn't open yet)
    //
    // After auto-step check passes, we update currentInfLocation and send
    // the DAP 'stopped' event so VS Code refreshes the UI.
    private onVmBreak(vmAddr: number, isStep: boolean, vmState: VmState): void {
        this.currentVmAddr  = vmAddr;
        this.currentVmState = vmState;
        if (this.debugInfo) {
            const loc = this.debugInfo.vmAddrToBgl(vmAddr);
            const locStr = loc ? `${nodePath.basename(loc.file)}:${loc.line}` : '(unmapped)';
            dbgLog(`${isStep ? 'step' : 'break'} @ 0x${vmAddr.toString(16)} → ${locStr}`);
            this.currentBglFile = loc?.file;
            this.currentBglLine = loc?.line;

            // Decide stop-vs-auto-step via the shared, harness-tested logic.
            const action = routeBreak({
                vmAddr, isStep,
                frames: vmState.frames ?? [],
                lastStepCommand: this.lastStepCommand as 'next' | 'stepIn' | 'stepOut' | undefined,
                stepOriginRoutine: this.stepOriginRoutine,
                // Governs the "auto-step past unmapped → next .bgl line" fallback: only for a
                // .bgl-mode step. An I6/library-mode step must stop on the .inf line instead.
                inI6Mode: this.stepInitiatedI6Mode,
                currentInfLocation: this.currentInfLocation,
                di: this.debugInfo,
            });
            if (action.kind === 'autostep') {
                this.panel?.sendStep(action.skipAddrs, action.stopAddrs, action.seqPts);
                return;
            }

            const infLoc = this.debugInfo.vmAddrToInfLocation(vmAddr);
            this.currentInfLocation = infLoc;
            this.currentInfLine = infLoc?.line;
            if (infLoc) {
                this.showInfLine(infLoc.path, infLoc.line);
            }
        }
        this.updateI6Button();
        this.lastStopReason = isStep ? 'step' : 'breakpoint';
        // Attribute a breakpoint stop to the file+line the user set it on, so stackTrace can
        // navigate there regardless of which pane is active. Step stops clear it.
        this.breakpointHitSource = isStep ? undefined : this.lookupBreakpointSite(vmAddr);
        const spec = this.breakpointHitSource
            ? this.breakpointSpecs.get(this.breakpointHitSource.file)?.get(this.breakpointHitSource.line) : undefined;
        if (spec) { void this.checkBreakpoint(spec); return; }
        this.sendEvent('stopped', {
            reason: this.lastStopReason,
            threadId: 1,
            allThreadsStopped: true,
        });
    }

    /**
     * A breakpoint with a condition, hit count or log message: it stops only when the condition holds
     * and the hit count is reached; a logpoint writes its message and goes on.
     */
    private async checkBreakpoint(spec: BreakpointSpec): Promise<void> {
        let stop = true;
        if (spec.condition) {
            const r = await this.evaluateCondition(spec.condition);
            if (r === undefined) {
                this.sendEvent('output', { category: 'console', output: `Breakpoint condition can't be evaluated: ${spec.condition}\n` });
            } else {
                stop = r;
            }
        }
        if (stop) {
            spec.hits++;
            if (spec.hitCondition) { stop = this.hitConditionMet(spec.hitCondition, spec.hits); }
        }
        if (stop && spec.logMessage !== undefined) {
            let text = spec.logMessage;
            for (const m of spec.logMessage.match(/\{[^{}]+\}/g) ?? []) {
                const r = await this.resolveExpression(m.slice(1, -1).trim(), 0);
                const v = r === undefined ? undefined : r.words ? this.makeInlineArrayVar('', r.words, r.type ?? 'array<int>')
                                                                 : await this.makeVarAsync('', r.raw, r.type);
                text = text.replace(m, v === undefined ? m : String(v.value));
            }
            this.sendEvent('output', { category: 'console', output: text + '\n' });
            stop = false;
        }
        if (stop) {
            this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
        } else {
            this.clearInfHighlight();
            this.hideI6Button();
            this.varRefMap.clear(); this.arrayRefMap.clear(); this.inlineArrayMap.clear(); this.refPath.clear();
            this.panel?.sendContinue();
        }
    }

    /** `>= 5`, `== 5`, `> 5`, `% 5` or a bare `5` (the same as `>= 5`, as VS Code's other debuggers read it). */
    private hitConditionMet(cond: string, hits: number): boolean {
        const m = /^\s*(>=|==|>|%)?\s*(\d+)\s*$/.exec(cond);
        if (!m) { return true; }
        const n = parseInt(m[2], 10);
        switch (m[1]) {
            case '==': return hits === n;
            case '>':  return hits > n;
            case '%':  return n > 0 && hits % n === 0;
            default:   return hits >= n;
        }
    }

    /** `a == b` (or != < <= > >=), `!a`, or a bare expression; each side a path, a number, true/false/null or 'c'. */
    private async evaluateCondition(cond: string): Promise<boolean | undefined> {
        const operand = async (text: string): Promise<number | undefined> => {
            const t = text.trim();
            if (/^-?\d+$/.test(t)) { return parseInt(t, 10); }
            if (/^\$[0-9A-Fa-f]+$/.test(t)) { return parseInt(t.slice(1), 16); }
            if (/^'.'$/.test(t)) { return t.charCodeAt(1); }
            if (/^(true|false|null)$/i.test(t)) { return /^true$/i.test(t) ? 1 : 0; }
            const r = await this.resolveExpression(t, 0);
            if (r === undefined || r.words) { return undefined; }
            const ty = r.type ?? 'int';
            return ty === 'uint' ? r.raw >>> 0 : this.signed(r.raw);
        };
        const m = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(cond);
        if (m) {
            const a = await operand(m[1]), b = await operand(m[3]);
            if (a === undefined || b === undefined) { return undefined; }
            switch (m[2]) {
                case '==': return a === b;
                case '!=': return a !== b;
                case '<':  return a < b;
                case '<=': return a <= b;
                case '>':  return a > b;
                default:   return a >= b;
            }
        }
        const neg = /^!\s*(.+)$/.exec(cond);
        const v = await operand(neg ? neg[1] : cond);
        return v === undefined ? undefined : neg ? v === 0 : v !== 0;
    }

    focusPanel(): void { this.panel?.focus(); }

    /** Give up the interpreter panel without closing it (see parkInterpreterPanel). */
    releasePanel(): vscode.WebviewPanel | undefined {
        const panel = this.panel?.release();
        this.panel = null;
        return panel;
    }

    private onPanelClosed(column: vscode.ViewColumn | undefined): void {
        if (column !== undefined) {
            this.context.globalState.update('debugPanelColumn', column);
        }
        this.hideI6Button();
        this.infHighlight.dispose();
        this.sendEvent('terminated');
    }

    /**
     * Show the "Open I6 Source" button in the active .bgl editor's title bar
     * when paused and the .inf file is not already visible; hide it otherwise.
     */
    private updateI6Button(): void {
        if (_activeAdapter !== this) { return; }
        if (!this.config?.bgldbgPath) { return; }
        const infFilePath = this.currentInfLocation?.path
            ?? this.config.infPath;

        // Track the inf editor column whenever it's visible (for open-beside logic).
        const infEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === infFilePath
        );
        if (infEditor?.viewColumn !== undefined) {
            this.context.globalState.update('infEditorColumn', infEditor.viewColumn);
        }

        if (this.currentInfLine === undefined) {
            this.hideI6Button();
            return;
        }
        // These are view-SWITCH buttons (.bgl title → jump to I6, .inf title → jump to Beguile),
        // so keep each available while paused whenever we hold a location in that file — do NOT
        // hide them once the counterpart is open. Previously both were gated on the target being
        // closed, so with both the .bgl and .inf panes up neither button appeared. The package.json
        // `when` clauses already scope them to the right editor by extension.
        vscode.commands.executeCommand('setContext', 'beguile.showOpenI6Button', true);
        vscode.commands.executeCommand('setContext', 'beguile.showOpenBglButton',
            !!this.currentBglFile && this.currentBglLine !== undefined);
    }

    private hideI6Button(): void {
        if (_activeAdapter !== this) { return; }
        vscode.commands.executeCommand('setContext', 'beguile.showOpenI6Button', false);
        vscode.commands.executeCommand('setContext', 'beguile.showOpenBglButton', false);
    }

    /** Open the .inf file and navigate to the line that corresponds to the current pause point. */
    doOpenI6Source(): void {
        if (!this.currentInfLocation) { return; }
        const infPath = this.currentInfLocation.path;
        const uri  = vscode.Uri.file(infPath);
        const line = this.currentInfLocation.line - 1; // 0-based

        const openAt = (col: vscode.ViewColumn) => {
            vscode.window.showTextDocument(uri, {
                preserveFocus: false,
                preview: false,
                viewColumn: col,
            }).then(editor => {
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                editor.setDecorations(this.infHighlight, [
                    new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER)
                ]);
            });
        };

        // If the user has opened the .inf before, reuse that column.
        const savedColumn = this.context.globalState.get<vscode.ViewColumn | undefined>('infEditorColumn');
        if (savedColumn !== undefined) {
            openAt(savedColumn);
            return;
        }

        // First time: split the .bgl editor's area so the .inf appears beside it
        // rather than becoming a tab in an unrelated group.
        const bglEditor = vscode.window.visibleTextEditors.find(
            e => this.currentBglFile && e.document.uri.fsPath === this.currentBglFile
        );
        if (bglEditor?.viewColumn !== undefined) {
            // Activate the .bgl editor group, then open Beside it to split it.
            vscode.window.showTextDocument(bglEditor.document, {
                viewColumn: bglEditor.viewColumn,
                preserveFocus: true,
            }).then(() => openAt(vscode.ViewColumn.Beside));
        } else {
            openAt(vscode.ViewColumn.Beside);
        }
    }

    /** Open the .bgl file and navigate to the current pause line. */
    doOpenBglSource(): void {
        if (!this.currentBglFile || this.currentBglLine === undefined) { return; }
        const uri  = vscode.Uri.file(this.currentBglFile);
        const line = this.currentBglLine - 1;
        vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false })
            .then(editor => {
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                editor.selection = new vscode.Selection(line, 0, line, 0);
            });
    }

    /** Highlight the given 1-based I6 line — only if that .inf file is already open. */
    private showInfLine(infFilePath: string, infLine: number): void {
        const editor  = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === infFilePath
        );
        if (!editor) { return; }

        const line  = infLine - 1; // VS Code is 0-based
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        editor.setDecorations(this.infHighlight, [range]);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }



    /** Clear the I6 highlight from all visible .inf editors. */
    private clearInfHighlight(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.fsPath.endsWith('.inf')) {
                editor.setDecorations(this.infHighlight, []);
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Format a single variable for the DAP `variables` response.
     * If `bglType` is known and is an object type, allocates a variablesReference
     * so VS Code shows an expand arrow.
     */
    /**
     * Expand a single object property into a DAP variable, handling special
     * types: `attributelist` (reads header bytes) and `array<dictionaryword>`
     * (decodes each dict-entry address into its word text).
     */
    private async expandPropAsync(
        p: { bglName: string; i6Name: string; type: string },
        objAddr: number
    ): Promise<any> {
        if (p.type === 'attributelist') {
            const bytes = this.panel ? await this.panel.readAttributes(objAddr) : null;
            if (bytes && this.debugInfo) {
                const names = this.debugInfo.activeAttributeNames(bytes);
                const display = names.length > 0 ? `{${names.join(', ')}}` : '{}';
                return { name: p.bglName, value: display, type: 'attributelist', variablesReference: 0 };
            }
            return { name: p.bglName, value: '{}', type: 'attributelist', variablesReference: 0 };
        }

        if (p.type === 'array<dictionaryword>') {
            const propNum = this.debugInfo!.propNumber(p.i6Name);
            const val = (propNum !== undefined && this.panel)
                ? await this.panel.readProperty(objAddr, propNum)
                : null;
            const addrs = Array.isArray(val) ? val : (val != null ? [val] : []);
            const words = this.panel
                ? await Promise.all(addrs.map((addr: number) => this.panel!.decodeDictWord(addr)))
                : [];
            const display = `{${words.map((w: string | null) => w ? `.${w}` : '0').join(', ')}}`;
            return { name: p.bglName, value: display, type: 'array<dictionaryword>', variablesReference: 0 };
        }

        // Regular property
        const propNum = this.debugInfo!.propNumber(p.i6Name);
        const val = (propNum !== undefined && this.panel)
            ? await this.panel.readProperty(objAddr, propNum)
            : null;
        // A member array is its property's data (several words); a `ref` member holds one pointer.
        if (Array.isArray(val) && val.length > 1 && p.type && p.type.startsWith('array<') && !p.type.startsWith('array<char>')) {
            return this.makeInlineArrayVar(p.bglName, val, p.type);
        }
        const raw = Array.isArray(val) ? (val[0] ?? 0) : (val ?? 0);
        return this.makeVarAsync(p.bglName, raw, p.type || undefined);
    }

    /**
     * Build DAP variables for locals SPILLED to the `_bglFrm` frame-pool (Z-machine
     * >15-local routines). These aren't VM frame slots, so we read `_bglFrm`'s value
     * from its frame slot and fetch each spilled local at `mem[_bglFrm] + index*WORDSIZE`.
     * Spilling only happens on the Z-machine (2-byte words); returns [] otherwise.
     */
    private async buildSpilledLocals(routine: any, vmFrame: any): Promise<any[]> {
        if (!routine || !this.debugInfo || !this.panel) { return []; }
        const spilled = this.debugInfo.spilledLocals(routine.startAddr);
        if (spilled.length === 0) { return []; }
        const frmLocal = routine.locals.find((l: any) => l.name === '_bglFrm');
        if (!frmLocal) { return []; }
        const frmVal = vmFrame.locals[frmLocal.frameOffset];
        if (!frmVal) { return []; }
        const WORDSIZE = 2; // spill is Z-machine-only → 2-byte words
        return Promise.all(spilled.map(async s => {
            const raw = await this.panel!.readWord(frmVal + s.index * WORDSIZE);
            return this.makeVarAsync(s.name, raw ?? 0, s.type);
        }));
    }

    /**
     * Evaluate a Watch/hover expression: a name (local, parameter, member of self, global or object)
     * followed by `.member`, `[index]` or `.length` steps. Names are matched as Beguile matches them,
     * ignoring case. `words` carries a member array read from its property's data.
     */
    private async resolveExpression(expr: string, frameId: number):
            Promise<{ raw: number; type: string | undefined; words?: number[] } | undefined> {
        const di = this.debugInfo;
        if (!di || !this.currentVmState || !expr) { return undefined; }
        const steps = expr.match(/[A-Za-z_]\w*|\[\s*-?\d+\s*\]|\./g);
        if (!steps || steps.join('').replace(/\s/g, '') !== expr.replace(/\s/g, '')) { return undefined; }
        const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        const WORDSIZE = this.config?.isZMachine ? 2 : 4;

        // The receiver of a method that is running, for `self` and bare member names.
        const selfAddr = di.selfAddress();
        const selfObj = selfAddr !== undefined ? (this.currentVmState.globals[selfAddr] ?? 0) : 0;
        const selfName = selfObj ? di.objectByAddr(selfObj) : undefined;
        const selfType = selfName ? di.objectTypeInfoFor(selfName) : undefined;

        let cur: { raw: number; type: string | undefined; words?: number[] } | undefined;
        const head = steps[0];
        const frames = this.currentVmState.frames;
        const vmFrame = frames[frames.length - 1 - frameId];
        if (eq(head, 'self') && selfObj) {
            cur = { raw: selfObj, type: selfType?.name ?? 'object' };
        }
        if (!cur && vmFrame) {
            const routine = di.routineByAddr(vmFrame.funcAddr) ?? di.routineContaining(vmFrame.funcAddr)
                         ?? (frameId === 0 && this.currentVmAddr !== undefined ? di.routineContaining(this.currentVmAddr) : undefined);
            const local = routine?.locals.find(l => eq(l.name, head));
            if (routine && local) {
                cur = { raw: (vmFrame.locals[local.frameOffset] ?? 0) as number, type: di.localVarType(routine.startAddr, local.name) };
            } else if (routine && this.panel) {
                const spilled = di.spilledLocals(routine.startAddr).find(x => eq(x.name, head));
                const frm = routine.locals.find(l => l.name === '_bglFrm');
                const frmVal = frm ? vmFrame.locals[frm.frameOffset] : 0;
                if (spilled && frmVal) {
                    cur = { raw: (await this.panel.readWord(frmVal + spilled.index * 2)) ?? 0, type: spilled.type };
                }
            }
        }
        if (!cur && selfType && selfObj) {
            const prop = selfType.props.find(p => eq(p.bglName, head));
            if (prop) { cur = await this.readMember(selfObj, prop); }
        }
        if (!cur) {
            const g = di.globals().find(x => eq(x.name, head));
            if (g) { cur = { raw: this.currentVmState.globals[g.address] ?? 0, type: di.globalVarType(g.name) }; }
        }
        if (!cur) {
            const a = di.userGlobalArrays().find(x => eq(x.name, head));
            if (a) { cur = { raw: a.address, type: di.globalVarType(a.name) }; }
        }
        if (!cur) {
            const o = di.userGlobalObjects().find(x => eq(x.name, head));
            if (o) { cur = { raw: o.address, type: di.objectTypeInfoFor(o.name)?.name ?? 'object' }; }
        }

        for (let i = 1; cur && i < steps.length; i++) {
            const step = steps[i];
            if (step === '.') { continue; }
            const t = cur.type ?? '';
            const isArray = t === 'array' || t.startsWith('array<') || t.startsWith('rawarray');
            if (step.startsWith('[')) {
                const idx = parseInt(step.slice(1, -1), 10);
                const elemType = this.arrayElementType(t);
                if (cur.words) {
                    if (idx < 0 || idx >= cur.words.length - 1) { return undefined; }
                    cur = { raw: cur.words[idx], type: elemType };
                } else if (isArray && this.panel && cur.raw) {
                    const offset = t.startsWith('rawarray') ? 0 : 1;
                    cur = { raw: (await this.panel.readWord(cur.raw + (idx + offset) * WORDSIZE)) ?? 0, type: elemType };
                } else { return undefined; }
                continue;
            }
            if (isArray && eq(step, 'length')) {
                if (cur.words) { cur = { raw: cur.words[cur.words.length - 1], type: 'int' }; continue; }
                if (!this.panel || !cur.raw) { return undefined; }
                const magic = await this.panel.readWord(cur.raw - 2 * WORDSIZE);
                cur = { raw: (await this.panel.readWord(magic === 0x9084 ? cur.raw - WORDSIZE : cur.raw)) ?? 0, type: 'int' };
                continue;
            }
            if (!cur.raw) { return undefined; }
            const objName = di.objectByAddr(cur.raw);
            const info = (t ? di.typeInfo(t) ?? di.objectTypeInfoFor(t) : undefined)
                      ?? (objName ? di.objectTypeInfoFor(objName) : undefined);
            const prop = info?.props.find(p => eq(p.bglName, step));
            if (!prop) { return undefined; }
            cur = await this.readMember(cur.raw, prop);
        }
        return cur;
    }

    /** One member of an object: its value and type, or the words of a member array held in the property. */
    private async readMember(objAddr: number, p: { i6Name: string; type: string }):
            Promise<{ raw: number; type: string | undefined; words?: number[] } | undefined> {
        const propNum = this.debugInfo?.propNumber(p.i6Name);
        if (propNum === undefined || !this.panel) { return undefined; }
        const val = await this.panel.readProperty(objAddr, propNum);
        if (Array.isArray(val) && val.length > 1 && p.type?.startsWith('array<') && !p.type.startsWith('array<char>')) {
            return { raw: 0, type: p.type, words: val };
        }
        return { raw: Array.isArray(val) ? (val[0] ?? 0) : (val ?? 0), type: p.type || undefined };
    }

    private async makeVarAsync(name: string, raw: number, bglType: string | undefined): Promise<any> {
        // Tracked word arrays (array<var>, array<int>, array<object>, …) render as an expandable row.
        // Also accept bare "array" (older/sized locals whose element type didn't reach the .bgldbg —
        // element type then defaults to var). array<char> is a byte buffer with a different layout;
        // skip it (the $9084 magic check in makeArrayVar also guards against non-word-array pointers).
        if (bglType && (bglType === 'array' || bglType.startsWith('array<') || bglType.startsWith('rawarray'))
            && !bglType.startsWith('array<char>')) {
            return this.makeArrayVar(name, raw, bglType);
        }
        if (bglType === 'bytearray' || bglType?.startsWith('array<char>')) {
            if (!raw) { return { name, value: 'null', type: 'array<char>', variablesReference: 0 }; }
            const text = await this.readByteArray(raw);
            return { name, value: text !== undefined ? `"${text}"` : `0x${(raw >>> 0).toString(16)}`, type: 'array<char>', variablesReference: 0 };
        }
        let decoded: string | undefined;
        if (bglType === 'string' && this.panel && raw) {
            decoded = (await this.panel.decodeString(raw)) ?? undefined;
        }
        // For generic `object` type, try to resolve to a named object at runtime
        if (bglType === 'object' && raw && this.debugInfo) {
            const objName = this.debugInfo.objectByAddr(raw);
            if (objName) {
                // Check for a specific typed class (e.g. room)
                const typed = this.debugInfo.globalVarType(objName);
                if (typed && typed !== 'object' && this.debugInfo.typeInfo(typed)) {
                    bglType = typed;
                } else {
                    // Use per-object sym info if available (expandable), otherwise show name only
                    const objInfo = this.debugInfo.objectTypeInfoFor(objName);
                    if (objInfo) {
                        bglType = objName;
                    } else {
                        return { name, value: objName, type: 'object', variablesReference: 0 };
                    }
                }
            }
        }
        return this.makeVar(name, raw, bglType, decoded);
    }

    /** Element type of an `array<T>` (or `array<T>[N]`) string; T may itself be `array<...>`. */
    private arrayElementType(bglType: string): string {
        const lt = bglType.indexOf('<');
        const gt = bglType.lastIndexOf('>');
        return (lt >= 0 && gt > lt) ? bglType.slice(lt + 1, gt).trim() : 'var';
    }

    /** Declared element count from an `array<T>[N]` type string, or undefined if unsized. */
    private arrayDeclaredSize(bglType: string): number | undefined {
        const m = /\]\s*$/.test(bglType) ? /\[(\d+)\]\s*$/.exec(bglType) : null;
        return m ? parseInt(m[1], 10) : undefined;
    }

    /**
     * Build an expandable Variables/Watch row for a tracked word array. Children are read lazily
     * (see the arrayRefMap branch in 'variables'). The $9084 magic is validated up front so a
     * non-array pointer — or an array<char> byte buffer, which uses a different layout — degrades
     * to a plain address instead of rendering garbage.
     *
     * Runtime layout (from `_bglArrayLocalAlloc` in __builtins.i6b and the global-array init in
     * i6Emitter.cpp): word[0] = capacity+2 · word[1..capacity] = elements · word[capacity+1] =
     * tracked length · word[capacity+2] = $9084. So `arr[i]` == readWord(base + (i+1)*WORDSIZE).
     */
    private async makeArrayVar(name: string, base: number, bglType: string): Promise<any> {
        const elemType = this.arrayElementType(bglType);
        const isRaw = bglType.startsWith('rawarray');
        const diag = (v: string) => ({ name, value: v, type: bglType, variablesReference: 0 });
        if (!base) { return diag('null'); }
        if (!this.panel) { return diag(`0x${(base >>> 0).toString(16)}`); }
        const WORDSIZE = this.config?.isZMachine ? 2 : 4;
        const declared = this.arrayDeclaredSize(bglType);

        if (isRaw) {
            // rawArray: a bare flat block — data from word 0, NO header/length/magic. Capacity is
            // only knowable from the declared [N] (a raw pointer has no recoverable extent).
            if (declared === undefined) { return diag(`rawarray<${elemType}> 0x${(base >>> 0).toString(16)}`); }
            const varRef = this.nextVarRef++;
            this.arrayRefMap.set(varRef, { base, elemType, capacity: declared, dataOffset: 0 });
            return { name, value: `rawarray<${elemType}> (size ${declared})`, type: bglType, variablesReference: varRef };
        }

        // array<T> layout (`_bglArrTracked` in _array.bgl): word[-2] = $9084 (or $DEAD once freed),
        // word[-1] = length, word[0] = capacity, word[1..capacity] = elements.
        const magic    = await this.panel.readWord(base - 2 * WORDSIZE);
        if (magic === 0xDEAD) { return diag(`array<${elemType}> (freed)`); }
        const length   = await this.panel.readWord(base - WORDSIZE);
        const header   = await this.panel.readWord(base);
        if (header == null) { return diag(`array<${elemType}> ⟨unreadable @0x${(base >>> 0).toString(16)}⟩`); }
        const capacity = declared ?? header;
        if (capacity < 0 || capacity > 4096) {
            return diag(`array<${elemType}> ⟨capacity ${header} @0x${(base >>> 0).toString(16)}⟩`);
        }
        const tracked = magic === 0x9084 && length != null && length >= 0 && length <= capacity;
        const shown = tracked ? length! : capacity;
        const varRef = this.nextVarRef++;
        this.arrayRefMap.set(varRef, { base, elemType, capacity: shown, dataOffset: 1 });
        const value = tracked ? `array<${elemType}> [${length}] (capacity ${capacity})` : `array<${elemType}> (size ${capacity})`;
        return { name, value, type: bglType, variablesReference: varRef };
    }

    /** A member array held in its property's data: the words are the elements, the last word the length. */
    private makeInlineArrayVar(name: string, words: number[], bglType: string): any {
        const elemType = this.arrayElementType(bglType);
        const capacity = words.length - 1;
        const length = words[capacity];
        const n = length >= 0 && length <= capacity ? length : capacity;
        const varRef = this.nextVarRef++;
        this.inlineArrayMap.set(varRef, { values: words.slice(0, n), elemType });
        return { name, value: `array<${elemType}> [${n}] (capacity ${capacity})`, type: bglType, variablesReference: varRef };
    }

    /** A word read as the signed value a Beguile int holds (reads come back unsigned). */
    private signed(raw: number): number {
        if (this.config?.isZMachine) { return raw > 0x7FFF && raw <= 0xFFFF ? raw - 0x10000 : raw; }
        return raw > 0x7FFFFFFF && raw <= 0xFFFFFFFF ? raw - 0x100000000 : raw;
    }

    /** The text of an `array<char>`: capacity in the word before it, its length in word 0, its bytes after. */
    private async readByteArray(addr: number): Promise<string | undefined> {
        if (!this.panel || !addr) { return undefined; }
        const WORDSIZE = this.config?.isZMachine ? 2 : 4;
        const length = await this.panel.readWord(addr);
        if (length == null || length < 0 || length > 1024) { return undefined; }
        let text = '';
        for (let i = 0; i < length; i += WORDSIZE) {
            const w = await this.panel.readWord(addr + WORDSIZE + i);
            if (w == null) { return undefined; }
            for (let b = 0; b < WORDSIZE && i + b < length; b++) {
                text += String.fromCharCode((w >>> (8 * (WORDSIZE - 1 - b))) & 0xFF);
            }
        }
        return text;
    }

    /** Types whose value is one word the Variables pane can write. */
    private isSettable(type: string | undefined): boolean {
        return type === 'int' || type === 'bool' || type === 'char' || type === 'uint'
            || (!!type && !!this.debugInfo?.isEnum(type));
    }

    private makeVar(name: string, raw: number, bglType: string | undefined, decoded?: string): any {
        if (bglType === 'bool') {
            return { name, value: raw ? 'true' : 'false', type: 'bool', variablesReference: 0 };
        }
        if (bglType === 'string') {
            return { name, value: decoded !== undefined ? `"${decoded}"` : '(string)', type: 'string', variablesReference: 0 };
        }
        if (bglType === 'int' || bglType === undefined) {
            return { name, value: String(this.signed(raw)), type: bglType ?? 'int', variablesReference: 0 };
        }
        if (bglType === 'uint') {
            return { name, value: String(raw >>> 0), type: 'uint', variablesReference: 0 };
        }
        if (bglType === 'char') {
            const c = raw & 0xFF;
            const shown = c >= 32 && c < 127 ? `'${String.fromCharCode(c)}' (${c})` : String(c);
            return { name, value: shown, type: 'char', variablesReference: 0 };
        }
        if (bglType === 'float' && !this.config?.isZMachine) {
            const buf = new DataView(new ArrayBuffer(4));
            buf.setUint32(0, raw >>> 0);
            return { name, value: String(buf.getFloat32(0)), type: 'float', variablesReference: 0 };
        }
        // Enum type — show "ValueName (N)"; a bnum's set shows its flags.
        if (this.debugInfo?.isEnum(bglType)) {
            let label = this.debugInfo.enumValueName(bglType, raw);
            if (label === undefined && raw > 0) {
                const flags: string[] = [];
                for (let bit = 1; bit > 0 && bit <= raw; bit <<= 1) {
                    if (raw & bit) {
                        const f = this.debugInfo.enumValueName(bglType, bit);
                        if (f === undefined) { flags.length = 0; break; }
                        flags.push(f);
                    }
                }
                if (flags.length > 0) { label = flags.join(' | '); }
            }
            const display = label !== undefined ? `${label} (${raw})` : String(raw);
            return { name, value: display, type: bglType, variablesReference: 0 };
        }
        // Object type — expandable if we have type info for it
        const objTypeInfo = this.debugInfo?.typeInfo(bglType) ?? this.debugInfo?.objectTypeInfoFor(bglType);
        if (objTypeInfo) {
            if (!raw) { return { name, value: 'null', type: objTypeInfo.name, variablesReference: 0 }; }
            const varRef = this.nextVarRef++;
            this.varRefMap.set(varRef, { objAddr: raw, typeName: objTypeInfo.name });
            const objName = this.debugInfo?.objectByAddr(raw);
            const shown = objName && objName.toLowerCase() !== objTypeInfo.name.toLowerCase()
                ? `${objName} (${objTypeInfo.name})` : objTypeInfo.name;
            return { name, value: shown, type: objTypeInfo.name, variablesReference: varRef };
        }
        // Known type name but no property info yet — show as plain int
        return { name, value: String(raw), type: bglType, variablesReference: 0 };
    }

    private respond(request: any, body: any, errorMessage?: string): void {
        const msg: any = {
            type: 'response',
            request_seq: request.seq,
            command: request.command,
            success: !errorMessage,
            body,
        };
        if (errorMessage) {
            msg.message = errorMessage;
        }
        this.send(msg);
    }

    private sendEvent(event: string, body?: any): void {
        const msg: any = { type: 'event', event };
        if (body) { msg.body = body; }
        this.send(msg);
    }

    private send(msg: any): void {
        msg.seq = this.msgSeq++;
        this._onDidSendMessage.fire(msg);
    }

    dispose(): void {
        if (_activeAdapter === this) { _activeAdapter = null; }
        this.hideI6Button();
        this.panel?.dispose();
        this._onDidSendMessage.dispose();
    }
}
