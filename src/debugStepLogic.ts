/**
 * debugStepLogic.ts — PURE stepping-decision logic, shared by the DAP adapter and the
 * runtime harness so the harness tests the ACTUAL code path (not a mirror of it).
 *
 * Two decisions live here, both free of vscode/panel state (their vscode-derived inputs —
 * `mainInfOpen`, `inI6Mode` — are passed in by the adapter):
 *   - computeStep : given a step command + current state, the addresses to send the VM
 *                   (skip / stop / seq-point-split).
 *   - routeBreak  : when the VM stops, whether to auto-step past it (and where) or stop.
 *
 * The adapter supplies the vscode bits and performs the side effects; this module only decides.
 */
import { DebugInfo, RoutineInfo } from './debugInfo';

export interface Frame { funcAddr: number; returnPC: number; locals: { [off: number]: number }; }

// ── computeStep — the step-handler's stop/skip/seq-pt plan ────────────────────
export interface StepInput {
    command: 'next' | 'stepIn' | 'stepOut';
    currentVmAddr: number | undefined;
    currentBglFile: string | undefined;
    currentBglLine: number | undefined;
    frames: Frame[];
    /** main .inf pane visible (vscode-derived; the adapter passes it in). */
    mainInfOpen: boolean;
    di: DebugInfo;
}
export interface StepPlan { skipAddrs: number[]; stopAddrs: number[]; seqPts: number[]; }

export function computeStep(inp: StepInput): StepPlan {
    const { command, currentVmAddr, currentBglFile, currentBglLine, frames, mainInfOpen, di } = inp;
    let skipAddrs: number[] = [];
    let stopAddrs: number[] = [];
    let seqPts: number[] = [];

    const infLoc = currentVmAddr !== undefined ? di.vmAddrToInfLocation(currentVmAddr) : undefined;
    const atInfOnly = !!infLoc && !currentBglFile;
    // Return target: where the CURRENT routine returns to (its caller's resume). It's the caller
    // frame's return PC — frames[len-2] (the innermost frame is the routine we're in; it hasn't
    // called anyone). Lets `next`/`stepOut` stop when the routine RETURNS, even into unmapped code.
    const returnTarget = frames.length >= 2 ? frames[frames.length - 2].returnPC : 0;

    if (mainInfOpen || atInfOnly) {
        // I6 (fine) mode.
        seqPts = di.allVmAddrs();
        skipAddrs = infLoc
            ? di.vmAddrsForInfLine(infLoc.line, infLoc.path)
            : ((currentBglFile && currentBglLine !== undefined)
                ? di.bglToVmAddrs(currentBglFile, currentBglLine) : []);
        if (command === 'stepOut' && infLoc) {
            const currentFileAddrs = new Set(di.vmAddrsForInfFile(infLoc.path));
            stopAddrs = di.allVmAddrs().filter(a => !currentFileAddrs.has(a));
        } else if (command === 'next') {
            // Step-over: stop at the next seq-pt in the CURRENT routine (skipping called functions)
            // or at the return point. (allVmAddrs() would descend into every callee — and in library
            // code onVmBreak had nothing to fall back to, so it ran off the end.)
            const cur = currentVmAddr !== undefined ? di.routineContaining(currentVmAddr) : undefined;
            if (cur) {
                const inRoutine = di.allVmAddrs().filter(a => a >= cur.startAddr && a < cur.endAddr);
                stopAddrs = returnTarget ? [...inRoutine, returnTarget] : inRoutine;
            } else {
                stopAddrs = di.allVmAddrs();
            }
        } else {
            stopAddrs = di.allVmAddrs();   // stepIn: any sequence point (enter calls)
        }
    } else {
        // Coarse .bgl mode.
        skipAddrs = (currentBglFile && currentBglLine !== undefined)
            ? di.bglToVmAddrs(currentBglFile, currentBglLine) : [];
        const mapped = di.allMappedVmAddrs();
        if (command === 'stepOut') {
            if (returnTarget) {
                stopAddrs = [returnTarget];
                seqPts = [...mapped, returnTarget];
            } else {
                // No reliable return target (e.g. ZVM's single-frame state) — target by routine.
                const cur = currentVmAddr !== undefined ? di.routineContaining(currentVmAddr) : undefined;
                const curStart = cur?.startAddr;
                stopAddrs = curStart !== undefined
                    ? mapped.filter(a => di.routineContaining(a)?.startAddr !== curStart)
                    : mapped;
                seqPts = mapped;
            }
        } else {
            // next / stepIn: next mapped .bgl line OR (if this line returns) the caller's resume point.
            stopAddrs = returnTarget ? [...mapped, returnTarget] : mapped;
            seqPts    = returnTarget ? [...mapped, returnTarget] : mapped;
        }
    }
    return { skipAddrs, stopAddrs, seqPts };
}

// ── routeBreak — the onVmBreak stop-vs-auto-step decision ─────────────────────
export interface BreakInput {
    vmAddr: number;
    isStep: boolean;
    frames: Frame[];
    lastStepCommand: 'next' | 'stepIn' | 'stepOut' | undefined;
    stepOriginRoutine: RoutineInfo | undefined;
    /** an .inf file (main or the target's) is visible (vscode-derived). */
    inI6Mode: boolean;
    currentInfLocation: { path: string; line: number } | undefined;
    di: DebugInfo;
}
/** What onVmBreak should do. `autostep` = fire another step with these addrs; `stop` = surface it. */
export type BreakAction =
    | { kind: 'stop' }
    | { kind: 'autostep'; skipAddrs: number[]; stopAddrs: number[]; seqPts: number[] };

/** True while the step-origin routine is still on the call stack (entered a call, vs returned). */
export function stepOriginOnStack(di: DebugInfo, stepOriginRoutine: RoutineInfo | undefined, frames: Frame[]): boolean {
    if (!stepOriginRoutine) { return false; }
    const start = stepOriginRoutine.startAddr;
    return (frames ?? []).some(f => {
        const r = di.routineByAddr(f.funcAddr) ?? di.routineContaining(f.funcAddr);
        return r?.startAddr === start;
    });
}

export function routeBreak(inp: BreakInput): BreakAction {
    const { vmAddr, isStep, frames, lastStepCommand, stepOriginRoutine, inI6Mode, currentInfLocation, di } = inp;
    const loc = di.vmAddrToBgl(vmAddr);

    // Step-over call detection: if we landed in a DIFFERENT routine while origin is still on the
    // stack, we entered a call — skip it, continuing to the origin's return point. (If origin was
    // POPPED — a `return` exited it — we DON'T do this; we stop at the caller below.)
    if (isStep && loc && lastStepCommand === 'next' && stepOriginRoutine
            && stepOriginOnStack(di, stepOriginRoutine, frames)) {
        const newRoutine = di.routineContaining(vmAddr);
        if (newRoutine && newRoutine !== stepOriginRoutine) {
            const originStart = stepOriginRoutine.startAddr;
            const originEnd   = stepOriginRoutine.endAddr;
            const mappedAddrs = di.allMappedVmAddrs();
            const returnAddrs = mappedAddrs.filter(a => a >= originStart && a < originEnd);
            if (returnAddrs.length > 0) {
                return { kind: 'autostep', skipAddrs: [vmAddr], stopAddrs: returnAddrs, seqPts: mappedAddrs };
            }
        }
    }

    if (isStep && !loc) {
        const infLoc2 = di.vmAddrToInfLocation(vmAddr);
        void infLoc2;
        const showTarget = lastStepCommand === 'stepIn' || lastStepCommand === 'stepOut';
        // If we stepped `next` and just RETURNED out of the origin routine (origin popped) into an
        // UNMAPPED caller — a library routine with no .bgl line — stop HERE at the return point
        // (shown in the .inf) instead of auto-stepping past it and running off the end.
        const returnedToCaller = lastStepCommand === 'next'
            && !!stepOriginRoutine && !stepOriginOnStack(di, stepOriginRoutine, frames);
        if (!inI6Mode && !showTarget && !returnedToCaller) {
            return { kind: 'autostep', skipAddrs: [vmAddr], stopAddrs: di.allMappedVmAddrs(), seqPts: di.allVmAddrs() };
        }
    }

    // Same-line auto-step: one I6 line may compile to multiple instructions; skip duplicate stops
    // on the same .inf line during step-over.
    const infLoc = di.vmAddrToInfLocation(vmAddr);
    if (isStep && lastStepCommand === 'next' && infLoc && currentInfLocation
            && infLoc.path === currentInfLocation.path && infLoc.line === currentInfLocation.line) {
        const skipAddrs = di.vmAddrsForInfLine(infLoc.line, infLoc.path);
        return { kind: 'autostep', skipAddrs, stopAddrs: di.allVmAddrs(), seqPts: di.allVmAddrs() };
    }

    return { kind: 'stop' };
}
