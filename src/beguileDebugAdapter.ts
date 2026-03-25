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

interface VmFrame  { funcAddr: number; returnPC: number; locals: { [frameOffset: number]: number } }
interface VmState  { frames: VmFrame[]; globals: { [address: number]: number } }

// ─── Module-level singletons ──────────────────────────────────────────────────

let _activeAdapter: BeguileDebugAdapter | null = null;
let _outputChannel: vscode.OutputChannel | null = null;

/** Called from extension.ts activate() to share the Beguile output channel. */
export function setBeguileOutputChannel(ch: vscode.OutputChannel): void {
    _outputChannel = ch;
}

function dbgLog(msg: string): void {
    _outputChannel?.appendLine(`[debug] ${msg}`);
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
    private currentVmAddr:  number | undefined;
    private currentBglFile: string | undefined;
    private currentBglLine: number | undefined;
    private currentInfLine: number | undefined;
    private currentVmState: VmState | undefined;
    private msgSeq = 1;

    /**
     * Maps a variablesReference id (≥ 3000) to the object address + type name
     * for object-typed variables that can be expanded in the Variables pane.
     * Cleared on every resume so stale refs don't survive across steps.
     */
    private varRefMap  = new Map<number, { objAddr: number; typeName: string }>();
    private nextVarRef = 3000;

    /** Fixed variablesReference for the "Self" scope. */
    private static readonly SELF_SCOPE_REF = 3;
    /** Fixed variablesReference for the merged filter-results scope. */
    private static readonly FILTER_SCOPE_REF = 4;

    /** Current name filter applied to all variable scopes. Empty = no filter. */
    private varFilter = '';
    private lastStopReason = 'breakpoint';

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
                    (col) => this.onPanelClosed(col)
                );
                this.respond(message, {});
                // Send 'initialized' now that the panel exists, so VS Code sends
                // setBreakpoints while panel is ready to receive them.
                this.sendEvent('initialized');
                break;
            }

            case 'setBreakpoints': {
                const src = message.arguments?.source?.path ?? '';
                const bps = (message.arguments?.breakpoints ?? []) as Array<{ line: number }>;

                dbgLog(`setBreakpoints: src=${src} bps=${JSON.stringify(bps.map(b=>b.line))} hasDebugInfo=${!!this.debugInfo}`);
                if (this.debugInfo && src.endsWith('.bgl')) {
                    const verified: Array<{ verified: boolean; line: number; message?: string }> = [];
                    const addrs = new Set<number>();

                    for (const bp of bps) {
                        const vmAddrs = this.debugInfo.bglToVmAddrs(src, bp.line);
                        dbgLog(`  line ${bp.line} → vmAddrs=[${vmAddrs.map(a=>'0x'+a.toString(16)).join(',')}]`);
                        if (vmAddrs.length > 0) {
                            verified.push({ verified: true, line: bp.line });
                            for (const a of vmAddrs) { addrs.add(a); }
                        } else {
                            verified.push({ verified: false, line: bp.line, message: 'No code at this line' });
                        }
                    }

                    dbgLog(`  → updateBreakpoints with ${addrs.size} addrs`);
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
                const infPath = this.config?.bgldbgPath.replace(/\.bgldbg$/, '');
                const isDocOpen = (p: string) =>
                    vscode.workspace.textDocuments.some(d => d.uri.fsPath === p);
                const infOpen = !!infPath && isDocOpen(infPath);
                const bglOpen = (file: string) => isDocOpen(file);

                // When the .bgl file is closed and .inf is open, report the I6 source so
                // VS Code navigates there instead of auto-reopening the .bgl file.
                const resolveSource = (bglLoc: BglLocation | undefined, infLine: number | undefined) => {
                    if (bglLoc && bglOpen(bglLoc.file)) {
                        return { source: { path: bglLoc.file, name: nodePath.basename(bglLoc.file) }, line: bglLoc.line };
                    }
                    if (infOpen && infPath && infLine !== undefined) {
                        return { source: { path: infPath, name: nodePath.basename(infPath) }, line: infLine };
                    }
                    if (bglLoc) {
                        return { source: { path: bglLoc.file, name: nodePath.basename(bglLoc.file) }, line: bglLoc.line };
                    }
                    return null;
                };

                // vmFrames is ordered bottom→top; display top→bottom (innermost first)
                for (let i = vmFrames.length - 1; i >= 0; i--) {
                    const vmf     = vmFrames[i];
                    const frameId = vmFrames.length - 1 - i; // 0 = innermost
                    const routine = this.debugInfo?.routineByAddr(vmf.funcAddr);
                    const name    = routine?.name ?? `0x${vmf.funcAddr.toString(16)}`;

                    let bglLoc: BglLocation | undefined;
                    let infLine: number | undefined;
                    if (frameId === 0) {
                        if (this.currentBglFile && this.currentBglLine !== undefined) {
                            bglLoc = { file: this.currentBglFile, line: this.currentBglLine };
                        }
                        infLine = this.currentInfLine;
                    } else if (vmf.returnPC && this.debugInfo) {
                        bglLoc  = this.debugInfo.vmAddrToBgl(vmf.returnPC);
                        infLine = this.debugInfo.vmAddrToInfLine(vmf.returnPC);
                    }

                    const src = resolveSource(bglLoc, infLine);
                    if (src) {
                        frames.push({ id: frameId, name, ...src, column: 1 });
                    } else {
                        frames.push({ id: frameId, name, line: 0, column: 0 });
                    }
                }
                if (frames.length === 0 && this.currentBglFile && this.currentBglLine !== undefined) {
                    const src = resolveSource(
                        { file: this.currentBglFile, line: this.currentBglLine },
                        this.currentInfLine
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
                    const typeName = objName ? (this.debugInfo?.globalVarType(objName) ?? objName) : undefined;
                    if (typeName && this.debugInfo?.typeInfo(typeName)) {
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
                    }
                    // Self props
                    const selfAddrF = this.debugInfo?.selfAddress();
                    if (selfAddrF !== undefined && this.currentVmState && this.debugInfo && this.panel) {
                        const selfObjAddr = this.currentVmState.globals[selfAddrF] ?? 0;
                        const objName  = selfObjAddr ? this.debugInfo.objectByAddr(selfObjAddr) : undefined;
                        const typeName = objName ? (this.debugInfo.globalVarType(objName) ?? objName) : undefined;
                        const typeInfo = typeName ? this.debugInfo.typeInfo(typeName) : undefined;
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
                        const typeName = objName ? (this.debugInfo.globalVarType(objName) ?? objName) : undefined;
                        const typeInfo = typeName ? this.debugInfo.typeInfo(typeName) : undefined;
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
                    // Object globals: address is the fixed Glulx object address; value IS the address
                    for (const g of (this.debugInfo?.userGlobalObjects() ?? [])) {
                        if (f && !g.name.toLowerCase().includes(f)) { continue; }
                        const type = this.debugInfo?.globalVarType(g.name);
                        vars.push(this.makeVar(g.name, g.address, type));
                    }

                } else if (ref >= 3000) {
                    // ── Object property expansion ─────────────────────────────
                    const entry = this.varRefMap.get(ref);
                    if (entry && this.debugInfo && this.panel) {
                        const typeInfo = this.debugInfo.typeInfo(entry.typeName);
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
                        const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
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
                    }
                }

                if (vars.length === 0 && ref === BeguileDebugAdapter.FILTER_SCOPE_REF) {
                    vars.push({ name: 'No matches.', value: '', variablesReference: 0 });
                } else {
                    vars.sort((a, b) => a.name.localeCompare(b.name));
                }
                this.respond(message, { variables: vars });
                break;
            }

            case 'evaluate': {
                const expr      = (message.arguments?.expression ?? '').trim();
                const frameId2  = message.arguments?.frameId ?? 0;
                let   result    = '';

                if (this.debugInfo && this.currentVmState) {
                    // Search current frame locals first
                    const vmFrames = this.currentVmState.frames;
                    const frameIdx = vmFrames.length - 1 - frameId2;
                    const vmFrame  = frameIdx >= 0 ? vmFrames[frameIdx] : undefined;
                    if (vmFrame) {
                        const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
                                     ?? (frameId2 === 0 && this.currentVmAddr !== undefined
                                         ? this.debugInfo.routineContaining(this.currentVmAddr)
                                         : undefined);
                        const local = routine?.locals.find(l => l.name === expr);
                        if (local !== undefined) {
                            result = String(vmFrame.locals[local.frameOffset] ?? 0);
                        }
                    }
                    // Fall back to globals
                    if (result === '') {
                        const g = this.debugInfo.globals().find(g => g.name === expr);
                        if (g) { result = String(this.currentVmState.globals[g.address] ?? 0); }
                    }
                }

                if (result !== '') {
                    this.respond(message, { result, variablesReference: 0 });
                } else {
                    this.respond(message, {}, `Unknown variable: ${expr}`);
                }
                break;
            }

            case 'setVariable': {
                const ref     = message.arguments?.variablesReference ?? 0;
                const name    = (message.arguments?.name ?? '') as string;
                const strVal  = (message.arguments?.value ?? '') as string;

                // Parse the incoming string value: bool keywords, hex, or decimal.
                let numVal: number;
                if      (strVal === 'true')  { numVal = 1; }
                else if (strVal === 'false') { numVal = 0; }
                else {
                    numVal = /^0x/i.test(strVal) ? parseInt(strVal, 16) : parseInt(strVal, 10);
                    if (isNaN(numVal)) { this.respond(message, {}, `Invalid value: ${strVal}`); break; }
                }

                dbgLog(`setVariable ref=${ref} name="${name}" val="${strVal}"`);
                if (ref === 2 && this.debugInfo && this.panel) {
                    // ── Global variable ───────────────────────────────────────
                    const g = this.debugInfo.globals().find(g => g.name === name);
                    if (!g) { dbgLog(`setVariable: unknown global "${name}"`); this.respond(message, {}, `Unknown global: ${name}`); break; }
                    const type = this.debugInfo.globalVarType(name);
                    dbgLog(`setVariable global addr=0x${g.address.toString(16)} type=${type}`);
                    if (type !== 'int' && type !== 'bool') {
                        this.respond(message, {}, 'Only int and bool globals can be set');
                        break;
                    }
                    const ok = await this.panel.setGlobal(g.address, numVal);
                    dbgLog(`setVariable setGlobal result=${ok}`);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    // Keep the cached state in sync so the Variables pane reflects the change immediately.
                    if (this.currentVmState) { this.currentVmState.globals[g.address] = numVal; }
                    const display = type === 'bool' ? (numVal ? 'true' : 'false') : String(numVal);
                    this.respond(message, { value: display, type });

                } else if (ref === BeguileDebugAdapter.SELF_SCOPE_REF && this.debugInfo && this.panel && this.currentVmState) {
                    // ── Self property ─────────────────────────────────────────
                    const selfAddr    = this.debugInfo.selfAddress();
                    const selfObjAddr = selfAddr ? (this.currentVmState.globals[selfAddr] ?? 0) : 0;
                    const objName     = selfObjAddr ? this.debugInfo.objectByAddr(selfObjAddr) : undefined;
                    const typeName    = objName ? (this.debugInfo.globalVarType(objName) ?? objName) : undefined;
                    const typeInfo    = typeName ? this.debugInfo.typeInfo(typeName) : undefined;
                    const prop        = typeInfo?.props.find(p => p.bglName === name);
                    if (!prop || !selfObjAddr) { this.respond(message, {}, 'Unknown property or no current object'); break; }
                    if (prop.type !== 'int' && prop.type !== 'bool') { this.respond(message, {}, 'Only int and bool properties can be set'); break; }
                    const propId = this.debugInfo.propNumber(prop.i6Name);
                    if (propId === undefined) { this.respond(message, {}, `Property number unknown for: ${prop.i6Name}`); break; }
                    const ok = await this.panel.setProp(selfObjAddr, propId, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    const display = prop.type === 'bool' ? (numVal ? 'true' : 'false') : String(numVal);
                    this.respond(message, { value: display, type: prop.type });

                } else if (this.varRefMap.has(ref) && this.debugInfo && this.panel) {
                    // ── Object property ───────────────────────────────────────
                    const entry = this.varRefMap.get(ref)!;
                    const typeInfo = this.debugInfo.typeInfo(entry.typeName);
                    const prop = typeInfo?.props.find(p => p.bglName === name);
                    if (!prop) { this.respond(message, {}, `Unknown property: ${name}`); break; }
                    if (prop.type !== 'int' && prop.type !== 'bool') {
                        this.respond(message, {}, 'Only int and bool properties can be set');
                        break;
                    }
                    const propId = this.debugInfo.propNumber(prop.i6Name);
                    if (propId === undefined) { this.respond(message, {}, `Property number unknown for: ${prop.i6Name}`); break; }
                    const ok = await this.panel.setProp(entry.objAddr, propId, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    const display = prop.type === 'bool' ? (numVal ? 'true' : 'false') : String(numVal);
                    this.respond(message, { value: display, type: prop.type });

                } else if (ref >= 1000 && !this.varRefMap.has(ref) && this.debugInfo && this.panel && this.currentVmState) {
                    // ── Local variable ────────────────────────────────────────
                    const frameDepth = ref - 1000;
                    const vmFrames   = this.currentVmState.frames;
                    // vmFrames[0]=outermost, vmFrames[length-1]=innermost; frameDepth 0=innermost
                    const vmFrame    = vmFrames[vmFrames.length - 1 - frameDepth];
                    if (!vmFrame) { this.respond(message, {}, 'Invalid frame'); break; }

                    const routine = this.debugInfo.routineByAddr(vmFrame.funcAddr)
                                 ?? (frameDepth === 0 && this.currentVmAddr !== undefined
                                     ? this.debugInfo.routineContaining(this.currentVmAddr)
                                     : undefined);
                    const local = routine?.locals.find(l => l.name === name);
                    if (!local) { this.respond(message, {}, `Unknown local: ${name}`); break; }

                    const type = routine
                        ? this.debugInfo.localVarType(routine.startAddr, name)
                        : undefined;
                    if (type !== undefined && type !== 'int' && type !== 'bool') {
                        this.respond(message, {}, 'Only int and bool locals can be set');
                        break;
                    }
                    // stackIdx: Quixe stack is also ordered outermost→innermost,
                    // so the frame at frameDepth d is at stack index length-1-d.
                    const stackIdx = vmFrames.length - 1 - frameDepth;
                    const ok = await this.panel.setLocal(stackIdx, local.frameOffset, numVal);
                    if (!ok) { this.respond(message, {}, 'Write failed'); break; }
                    // Update cached state so Variables pane is immediately consistent.
                    vmFrame.locals[local.frameOffset] = numVal;
                    const display = type === 'bool' ? (numVal ? 'true' : 'false') : String(numVal);
                    this.respond(message, { value: display, type: type ?? 'int' });

                } else {
                    this.respond(message, {}, 'Cannot set variable in this scope');
                }
                break;
            }

            case 'continue': {
                this.clearInfHighlight();
                this.hideI6Button();
                this.varRefMap.clear();
                dbgLog(`continue → addr 0x${(this.currentVmAddr ?? 0).toString(16)}`);
                this.panel?.sendContinue();
                this.respond(message, { allThreadsContinued: true });
                break;
            }

            case 'next':
            case 'stepIn':
            case 'stepOut': {
                this.clearInfHighlight();
                this.hideI6Button();
                this.varRefMap.clear();

                let skipAddrs: number[] = [];
                let stopAddrs: number[] = [];

                if (this.debugInfo) {
                    const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
                    const infOpen = vscode.window.visibleTextEditors.some(
                        e => e.document.uri.fsPath === infPath
                    );

                    if (infOpen && this.currentVmAddr !== undefined) {
                        // Fine-grained: step to the next I6 sequence point
                        const infLine = this.debugInfo.vmAddrToInfLine(this.currentVmAddr);
                        skipAddrs = infLine !== undefined
                            ? this.debugInfo.vmAddrsForInfLine(infLine)
                            : [];
                        stopAddrs = this.debugInfo.allVmAddrs();
                    } else {
                        // Coarse: step to the next different .bgl line.
                        // Use allMappedVmAddrs so the VM stops only at addresses
                        // that have a .bgl mapping — no auto-step churn needed.
                        skipAddrs = (this.currentBglFile && this.currentBglLine !== undefined)
                            ? this.debugInfo.bglToVmAddrs(this.currentBglFile, this.currentBglLine)
                            : [];
                        stopAddrs = this.debugInfo.allMappedVmAddrs();
                    }
                }

                const seqPts = this.debugInfo?.allVmAddrs();
                this.panel?.sendStep(skipAddrs, stopAddrs, seqPts);
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
                await this.closeInfTab();
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

    private onVmBreak(vmAddr: number, isStep: boolean, vmState: VmState): void {
        this.currentVmAddr  = vmAddr;
        this.currentVmState = vmState;
        if (this.debugInfo) {
            const loc = this.debugInfo.vmAddrToBgl(vmAddr);
            const locStr = loc ? `${nodePath.basename(loc.file)}:${loc.line}` : '(unmapped)';
            dbgLog(`${isStep ? 'step' : 'break'} @ 0x${vmAddr.toString(16)} → ${locStr}`);
            this.currentBglFile = loc?.file;
            this.currentBglLine = loc?.line;

            // If we stopped at an I6 sequence point that has no .bgl mapping,
            // skip past it automatically (only during a coarse bgl-level step).
            if (isStep && !loc) {
                const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
                const infOpen = vscode.window.visibleTextEditors.some(
                    e => e.document.uri.fsPath === infPath
                );
                if (!infOpen) {
                    // Auto-step: skip this addr, stop only at bgl-mapped addresses
                    const mappedAddrs = this.debugInfo.allMappedVmAddrs();
                    this.panel?.sendStep([vmAddr], mappedAddrs, this.debugInfo.allVmAddrs());
                    return;
                }
            }

            const infLine = this.debugInfo.vmAddrToInfLine(vmAddr);
            this.currentInfLine = infLine;
            if (infLine !== undefined) {
                this.showInfLine(infLine);
            }
        }
        this.updateI6Button();
        this.lastStopReason = isStep ? 'step' : 'breakpoint';
        this.sendEvent('stopped', {
            reason: this.lastStopReason,
            threadId: 1,
            allThreadsStopped: true,
        });
    }

    private onPanelClosed(column: vscode.ViewColumn | undefined): void {
        if (column !== undefined) {
            this.context.globalState.update('debugPanelColumn', column);
        }
        this.hideI6Button();
        this.closeInfTab();
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
        const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
        const isDocOpen = (p: string) => vscode.window.tabGroups.all.some(
            g => g.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === p)
        );
        const infOpen = isDocOpen(infPath);

        // Track the inf editor column whenever it's visible (for open-beside logic).
        const infEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === infPath
        );
        if (infEditor?.viewColumn !== undefined) {
            this.context.globalState.update('infEditorColumn', infEditor.viewColumn);
        }

        if (this.currentInfLine === undefined) {
            this.hideI6Button();
            return;
        }
        const bglOpen = !!this.currentBglFile && isDocOpen(this.currentBglFile);
        // I6 button: show on .bgl editor when I6 file is not open
        vscode.commands.executeCommand('setContext', 'beguile.showOpenI6Button', !infOpen);
        // BGL button: show on .inf editor when I6 file is open but bgl file is not
        vscode.commands.executeCommand('setContext', 'beguile.showOpenBglButton',
            infOpen && !bglOpen && !!this.currentBglFile);
    }

    private hideI6Button(): void {
        if (_activeAdapter !== this) { return; }
        vscode.commands.executeCommand('setContext', 'beguile.showOpenI6Button', false);
        vscode.commands.executeCommand('setContext', 'beguile.showOpenBglButton', false);
    }

    /** Open the .inf file and navigate to the line that corresponds to the current pause point. */
    doOpenI6Source(): void {
        if (this.currentInfLine === undefined) { return; }
        const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
        const uri  = vscode.Uri.file(infPath);
        const line = this.currentInfLine - 1; // 0-based

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

    /** Highlight the given 1-based I6 line — only if the .inf file is already open. */
    private showInfLine(infLine: number): void {
        const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
        const editor  = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === infPath
        );
        if (!editor) { return; }

        const line  = infLine - 1; // VS Code is 0-based
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        editor.setDecorations(this.infHighlight, [range]);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Close the .inf tab if it is open. */
    private async closeInfTab(): Promise<void> {
        const infPath = this.config.bgldbgPath.replace(/\.bgldbg$/, '');
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText &&
                    tab.input.uri.fsPath === infPath) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
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
        const raw = Array.isArray(val) ? (val[0] ?? 0) : (val ?? 0);
        return this.makeVarAsync(p.bglName, raw, p.type);
    }

    /**
     * Resolve a generic `object`-typed variable to its specific Beguile type by
     * scanning the live global state.  Two strategies, in order:
     *
     * 1. Glulx: `objectByAddr(raw)` gives the I6 name directly from the .dbg
     *    object table (memory address → identifier).
     * 2. Both platforms: scan all typed globals whose current runtime value
     *    matches `raw`.  E.g. if `location == 7` and `bar`'s slot also == 7,
     *    we infer location is a `bar` (type `room`).
     *
     * Returns the resolved type name, or undefined if unresolvable.
     */
    private resolveObjectType(raw: number): string | undefined {
        if (!raw || !this.debugInfo) { return undefined; }
        // Strategy 1: Glulx direct lookup
        const objName = this.debugInfo.objectByAddr(raw);
        if (objName) {
            return this.debugInfo.globalVarType(objName) ?? objName;
        }
        // Strategy 2: scan typed globals for a value match
        if (this.currentVmState) {
            const globalVals = this.currentVmState.globals;
            for (const g of this.debugInfo.userGlobals()) {
                const gType = this.debugInfo.globalVarType(g.name);
                if (!gType || !this.debugInfo.typeInfo(gType)) { continue; }
                if (globalVals[g.address] === raw) { return gType; }
            }
        }
        return undefined;
    }

    private async makeVarAsync(name: string, raw: number, bglType: string | undefined): Promise<any> {
        let decoded: string | undefined;
        if (bglType === 'string' && this.panel && raw) {
            decoded = (await this.panel.decodeString(raw)) ?? undefined;
        }
        // For generic `object` type, try to resolve to a specific type at runtime
        if (bglType === 'object') {
            const resolved = this.resolveObjectType(raw);
            if (resolved) { bglType = resolved; }
        }
        return this.makeVar(name, raw, bglType, decoded);
    }

    private makeVar(name: string, raw: number, bglType: string | undefined, decoded?: string): any {
        if (bglType === 'bool') {
            return { name, value: raw ? 'true' : 'false', type: 'bool', variablesReference: 0 };
        }
        if (bglType === 'string') {
            return { name, value: decoded !== undefined ? `"${decoded}"` : '(string)', type: 'string', variablesReference: 0 };
        }
        if (bglType === 'int' || bglType === undefined) {
            return { name, value: String(raw), type: bglType ?? 'int', variablesReference: 0 };
        }
        // Enum type — show "ValueName (N)"
        if (this.debugInfo?.isEnum(bglType)) {
            const label = this.debugInfo.enumValueName(bglType, raw);
            const display = label !== undefined ? `${label} (${raw})` : String(raw);
            return { name, value: display, type: bglType, variablesReference: 0 };
        }
        // Object type — expandable if we have type info for it
        if (this.debugInfo?.typeInfo(bglType)) {
            const varRef = this.nextVarRef++;
            this.varRefMap.set(varRef, { objAddr: raw, typeName: bglType });
            return { name, value: bglType, type: bglType, variablesReference: varRef };
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
