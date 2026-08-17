/**
 * debugInfo.ts
 * Loads and cross-references the debug files produced during a Beguile debug build:
 *
 *   <stem>.bgl.bgldbg                 — beguiler bundle (map + sym + types sections)
 *   <stem>.bgl.transpiled.inf.dbg     — Inform 6 XML debug database
 *
 * The .bgldbg bundle is a plain-text section-delimited file:
 *
 *   [map]     — tab-separated: infLine\tbglFile\tbglLine
 *   [sym]     — symbol table (reserved for future use)
 *   [types]   — Beguile type info (type/prop/routine/local/global lines)
 *
 * From the .dbg XML, <sequence-point> elements map VM bytecode addresses
 * to I6 source line numbers.  Cross-referenced with the [map] section this gives
 * the full chain:  VM address → I6 line → .bgl file + line.
 *
 * The [types] section maps Beguile-declared variables to their types, enabling
 * rich display of object-typed variables in the debugger.
 */

import * as fs   from 'fs';
import * as path from 'path';

export interface BglLocation {
    file: string;   // absolute path to .bgl file
    line: number;   // 1-based line number
}

export interface GlobalInfo {
    name:    string;
    address: number;
}

// ── Beguile type system ───────────────────────────────────────────────────────

/** A Beguile value type: a scalar keyword or the name of a Beguile type. */
export type BglType = 'int' | 'bool' | 'string' | string;

/** One property declared on a Beguile type. */
export interface BglProp {
    bglName: string;   // name shown in the debugger (Beguile name)
    i6Name:  string;   // identifier used in the .inf / .dbg (may differ)
    type:    BglType;  // value type of this property
}

/** A Beguile type with its property list. */
export interface BglTypeInfo {
    name:  string;
    props: BglProp[];
}

export interface LocalInfo {
    name:        string;
    frameOffset: number;
}

export interface RoutineInfo {
    name:      string;
    startAddr: number;
    endAddr:   number;  // exclusive (startAddr + byteCount)
    locals:    LocalInfo[];
}

export class DebugInfo {
    /**
     * infLine → bgl location(s). A single .inf line can legitimately host more than
     * one .bgl statement (e.g. inlined/collapsed emission), so this is a LIST, not a
     * single value. Keeping every candidate is load-bearing for the reverse direction
     * (`bglToVmAddrs`): a breakpoint on any of the .bgl lines that share an .inf line
     * must still bind. (Historically this was `Map<number, BglLocation>` with
     * last-write-wins, which silently dropped all but the last candidate.)
     */
    private infToBgl    = new Map<number, BglLocation[]>();
    /** VM bytecode address → { fileIndex, line } in the .dbg source table */
    private addrToInf   = new Map<number, { fileIndex: number; line: number }>();
    /** file-index → resolved absolute path of that .inf source file */
    private infFileIndex = new Map<number, string>();
    /** routine start address → RoutineInfo */
    private routineMap  = new Map<number, RoutineInfo>();
    /** sorted routine start addresses (for range lookup) */
    private routineAddrs: number[] = [];
    /** global variables from .dbg */
    private globalList: GlobalInfo[] = [];

    // ── Type-system data (from .types file + .dbg property table) ────────────
    /** I6 property identifier → compile-time property number (from .dbg) */
    private i6PropToNum  = new Map<string, number>();
    /** Beguile type name → BglTypeInfo (from .types) */
    private bglTypeMap   = new Map<string, BglTypeInfo>();
    /** I6 routine name → { varName → BglType } for locals (from .types) */
    private routineTyped = new Map<string, Map<string, BglType>>();
    /**
     * I6 routine name → { varName → storage metadata } for locals (from .types,
     * 4th/5th columns: `local <name> <type> <storage>[ synthetic]`). `storage` is
     * `slot` for a frame-resident local or `_bglFrm-->N` for one spilled to the
     * frame-pool at word offset N (Z-machine >15-local case). `synthetic` marks a
     * compiler-inserted local (e.g. the `_bglFrm` spill pointer) to hide.
     */
    private routineLocalMeta = new Map<string, Map<string, { storage: string; synthetic: boolean }>>();
    /** global variable name → BglType (from .types) */
    private globalTyped  = new Map<string, BglType>();
    /** Beguile enum name → (numeric value → display name) */
    private enumMap      = new Map<string, Map<number, string>>();
    /** I6 attribute bit number → attribute name (from .dbg <attribute> entries) */
    private attrBitMap   = new Map<number, string>();
    /** Per-object property lists from [sym] section (objName → BglProp[]) */
    private objSymProps  = new Map<string, BglProp[]>();
    /** I6 object identifier → Glulx memory address (from .dbg <object> entries) */
    private i6ObjMap     = new Map<string, number>();
    /** Reverse: Glulx memory address → I6 object identifier */
    private i6AddrToObj  = new Map<number, string>();
    /** Address of the I6 `self` global variable (or undefined if not in .dbg) */
    private selfGlobalAddr: number | undefined;

    static load(bgldbgPath: string, dbgPath: string): DebugInfo {
        const info = new DebugInfo();
        info.loadBundle(bgldbgPath);
        info.loadDbg(dbgPath);
        return info;
    }

    /**
     * Parse a .bgldbg bundle file.  The file is divided into named sections by
     * `[sectionName]` header lines; unknown sections are silently skipped.
     * Gracefully no-ops if the file is absent (shouldn't happen in practice —
     * the caller already verified existence — but protects against race conditions).
     */
    private loadBundle(bgldbgPath: string): void {
        let text: string;
        try { text = fs.readFileSync(bgldbgPath, 'utf8'); }
        catch { return; }

        let section = '';
        // State for [types] parsing
        let currentType:   { name: string; props: BglProp[] } | null = null;
        let currentLocals: Map<string, BglType> | null = null;
        let currentLocalMeta: Map<string, { storage: string; synthetic: boolean }> | null = null;
        let currentEnum:   Map<number, string> | null = null;

        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line) continue;

            // Section header
            if (line.startsWith('[') && line.endsWith(']')) {
                section = line.slice(1, -1);
                currentType   = null;
                currentLocals = null;
                continue;
            }

            switch (section) {
                case 'map': {
                    const parts = line.split('\t');
                    if (parts.length !== 3) break;
                    const infLine = parseInt(parts[0], 10);
                    const bglLine = parseInt(parts[2], 10);
                    if (!isNaN(infLine) && !isNaN(bglLine)) {
                        const loc = { file: path.resolve(parts[1]), line: bglLine };
                        const list = this.infToBgl.get(infLine);
                        if (!list) {
                            this.infToBgl.set(infLine, [loc]);
                        } else if (!list.some(l => l.file === loc.file && l.line === loc.line)) {
                            list.push(loc);   // dedup identical (file,line) repeats
                        }
                    }
                    break;
                }
                case 'sym': {
                    // Parse object property entries: "objName.propName i6Name property"
                    const dotIdx = line.indexOf('.');
                    if (dotIdx > 0) {
                        const symParts = line.split(/\t/);
                        if (symParts.length >= 3 && symParts[2] === 'property') {
                            const objName  = symParts[0].substring(0, dotIdx);
                            const i6Name   = symParts[1];
                            const bglName  = symParts[0].substring(dotIdx + 1);
                            let props = this.objSymProps.get(objName);
                            if (!props) { props = []; this.objSymProps.set(objName, props); }
                            props.push({ bglName, i6Name, type: '' });
                        }
                    }
                    break;
                }
                case 'types': {
                    if (line.startsWith('#')) break;
                    const parts = line.split(/\s+/);
                    switch (parts[0]) {
                        case 'enum':
                            currentType   = null;
                            currentLocals = null;
                            currentEnum   = new Map();
                            this.enumMap.set(parts[1], currentEnum);
                            break;
                        case 'value':
                            if (currentEnum && parts.length >= 3) {
                                currentEnum.set(parseInt(parts[2], 10), parts[1]);
                            }
                            break;
                        case 'type':
                            currentLocals = null;
                            currentEnum   = null;
                            currentType   = { name: parts[1], props: [] };
                            this.bglTypeMap.set(parts[1], currentType);
                            break;
                        case 'prop':
                            if (currentType && parts.length >= 4) {
                                currentType.props.push({
                                    bglName: parts[1],
                                    i6Name:  parts[2],
                                    type:    parts[3],
                                });
                            }
                            break;
                        case 'routine':
                            currentType   = null;
                            currentEnum   = null;
                            currentLocals = new Map();
                            currentLocalMeta = new Map();
                            this.routineTyped.set(parts[1], currentLocals);
                            this.routineLocalMeta.set(parts[1], currentLocalMeta);
                            break;
                        case 'local':
                            if (currentLocals && parts.length >= 3) {
                                currentLocals.set(parts[1], parts[2]);
                                // parts[3] = storage (`slot` | `_bglFrm-->N`), trailing `synthetic` marks a hide.
                                currentLocalMeta?.set(parts[1], {
                                    storage:   parts[3] ?? 'slot',
                                    synthetic: parts.slice(3).includes('synthetic'),
                                });
                            }
                            break;
                        case 'global':
                            if (parts.length >= 3) {
                                this.globalTyped.set(parts[1], parts[2]);
                            }
                            break;
                    }
                    break;
                }
            }
        }

        // Post-process: resolve sym property types from type definitions.
        // Build i6Name → type map from all typed properties, then fill in sym entries.
        const i6PropType = new Map<string, string>();
        for (const typeInfo of this.bglTypeMap.values()) {
            for (const p of typeInfo.props) {
                if (p.type) { i6PropType.set(p.i6Name, p.type); }
            }
        }
        for (const props of this.objSymProps.values()) {
            for (const p of props) {
                if (!p.type) { p.type = i6PropType.get(p.i6Name) ?? ''; }
            }
        }
    }

    private loadDbg(dbgPath: string): void {
        const xml = fs.readFileSync(dbgPath, 'utf8');

        // Read the include dirs from the generated .inf's ICL directives — where the I6 compiler
        // resolves included library files (parser.h, verblib.h, orLibrary, …). Beguiler emits the
        // ADDITIVE form `++include_path=` (one per dir, several lines), so match one-or-two `+` and
        // collect EVERY directive (the old single-`+`, break-after-one parse found none → library
        // frames resolved to a non-existent path in the output folder).
        const infPath = dbgPath.replace(/\.dbg$/, '');
        const i6SearchDirs: string[] = [path.dirname(dbgPath)];
        try {
            const infContent = fs.readFileSync(infPath, 'utf8');
            for (const line of infContent.split('\n')) {
                const m2 = /^!%\s*\+\+?include_path=(.+)/.exec(line.trim());
                if (m2) {
                    for (const p of m2[1].split(',')) {
                        const dir = p.trim();
                        if (dir && !i6SearchDirs.includes(dir)) { i6SearchDirs.push(dir); }
                    }
                }
            }
        } catch { /* .inf not readable — fall back to dbg dir only */ }

        // ── Source file index table ─────────────────────────────────────────
        // <given-path> entries appear in document order; their position (0-based)
        // is the file-index referenced by sequence points.
        const pathRe = /<given-path>([\s\S]*?)<\/given-path>/g;
        let m: RegExpExecArray | null;
        let fileIdx = 0;
        while ((m = pathRe.exec(xml)) !== null) {
            const raw = m[1].trim();
            let resolved: string;
            if (path.isAbsolute(raw)) {
                resolved = raw;
            } else if (path.extname(raw)) {
                // Has extension — resolve against dbg directory only
                resolved = path.join(path.dirname(dbgPath), raw);
            } else {
                // No extension (I6 library file like "parser") — search include dirs for <name>.h
                const found = i6SearchDirs.map(d => path.join(d, raw + '.h')).find(p => fs.existsSync(p));
                resolved = found ?? path.join(path.dirname(dbgPath), raw);
            }
            this.infFileIndex.set(fileIdx++, resolved);
        }

        // ── Sequence points ──────────────────────────────────────────────────
        const spRe = /<sequence-point>([\s\S]*?)<\/sequence-point>/g;
        while ((m = spRe.exec(xml)) !== null) {
            const block   = m[1];
            const addrM   = /<address>\s*(\d+)\s*<\/address>/.exec(block);
            const lineM   = /<line>\s*(\d+)\s*<\/line>/.exec(block);
            const fileIdxM = /<file-index>\s*(\d+)\s*<\/file-index>/.exec(block);
            if (addrM && lineM) {
                const addr      = parseInt(addrM[1],    10);
                const infLine   = parseInt(lineM[1],    10);
                const fileIndex = fileIdxM ? parseInt(fileIdxM[1], 10) : 0;
                if (!this.addrToInf.has(addr)) {
                    this.addrToInf.set(addr, { fileIndex, line: infLine });
                }
            }
        }

        // ── Routines (with local variables) ─────────────────────────────────
        const routineRe = /<routine>([\s\S]*?)<\/routine>/g;
        while ((m = routineRe.exec(xml)) !== null) {
            const block     = m[1];
            const nameM     = /<identifier[^>]*>(.*?)<\/identifier>/.exec(block);
            const addrM     = /<address>\s*(\d+)\s*<\/address>/.exec(block);
            const byteM     = /<byte-count>\s*(\d+)\s*<\/byte-count>/.exec(block);
            if (!nameM || !addrM) continue;

            const startAddr = parseInt(addrM[1], 10);
            const byteCount = byteM ? parseInt(byteM[1], 10) : 0;

            const locals: LocalInfo[] = [];
            const localRe = /<local-variable>([\s\S]*?)<\/local-variable>/g;
            let lm: RegExpExecArray | null;
            while ((lm = localRe.exec(block)) !== null) {
                const lb      = lm[1];
                const lnameM  = /<identifier[^>]*>(.*?)<\/identifier>/.exec(lb);
                const offsetM = /<frame-offset>\s*(\d+)\s*<\/frame-offset>/.exec(lb);
                const indexM  = /<index>\s*(\d+)\s*<\/index>/.exec(lb);
                if (lnameM && offsetM) {
                    // Glulx: frame-offset is the byte offset directly
                    locals.push({ name: lnameM[1], frameOffset: parseInt(offsetM[1], 10) });
                } else if (lnameM && indexM) {
                    // Z-machine: <index> is 1-based; locals are 2-byte values
                    // → byte offset = (index - 1) * 2
                    locals.push({ name: lnameM[1], frameOffset: (parseInt(indexM[1], 10) - 1) * 2 });
                }
            }

            const info: RoutineInfo = { name: nameM[1], startAddr, endAddr: startAddr + byteCount, locals };
            this.routineMap.set(startAddr, info);
        }
        this.routineAddrs = Array.from(this.routineMap.keys()).sort((a, b) => a - b);

        // ── Global variables ─────────────────────────────────────────────────
        const globalRe = /<global-variable>([\s\S]*?)<\/global-variable>/g;
        while ((m = globalRe.exec(xml)) !== null) {
            const block  = m[1];
            const nameM  = /<identifier[^>]*>(.*?)<\/identifier>/.exec(block);
            const addrM  = /<address>\s*(\d+)\s*<\/address>/.exec(block);
            if (nameM && addrM) {
                this.globalList.push({ name: nameM[1], address: parseInt(addrM[1], 10) });
            }
        }

        // ── Object table (identifier → Glulx memory address) ────────────────
        const objRe = /<object>([\s\S]*?)<\/object>/g;
        while ((m = objRe.exec(xml)) !== null) {
            const block = m[1];
            const nameM = /<identifier[^>]*>(.*?)<\/identifier>/.exec(block);
            const valM  = /<value>\s*(\d+)\s*<\/value>/.exec(block);
            if (nameM && valM) {
                const addr = parseInt(valM[1], 10);
                this.i6ObjMap.set(nameM[1], addr);
                if (addr !== 0) { this.i6AddrToObj.set(addr, nameM[1]); }
            }
        }

        // ── self global address ───────────────────────────────────────────────
        const selfM = /<global-variable><identifier>self<\/identifier><address>\s*(\d+)\s*<\/address><\/global-variable>/.exec(xml);
        if (selfM) { this.selfGlobalAddr = parseInt(selfM[1], 10); }

        // ── Property name → number (used to read object properties at runtime) ─
        const propRe = /<property>([\s\S]*?)<\/property>/g;
        while ((m = propRe.exec(xml)) !== null) {
            const block = m[1];
            const nameM = /<identifier[^>]*>(.*?)<\/identifier>/.exec(block);
            const valM  = /<value>\s*(\d+)\s*<\/value>/.exec(block);
            if (nameM && valM) {
                this.i6PropToNum.set(nameM[1], parseInt(valM[1], 10));
            }
        }

        // ── Attribute bit numbers (for decoding attributelist at runtime) ─────
        const attrRe = /<attribute>([\s\S]*?)<\/attribute>/g;
        while ((m = attrRe.exec(xml)) !== null) {
            const block = m[1];
            const nameM = /<identifier[^>]*>(.*?)<\/identifier>/.exec(block);
            const valM  = /<value>\s*(\d+)\s*<\/value>/.exec(block);
            if (nameM && valM) {
                const bit = parseInt(valM[1], 10);
                if (!this.attrBitMap.has(bit)) {   // first definition wins
                    this.attrBitMap.set(bit, nameM[1]);
                }
            }
        }
    }


    // ── Type-system queries ───────────────────────────────────────────────────

    /** Address of the I6 `self` global variable, or undefined if not in .dbg. */
    selfAddress(): number | undefined {
        return this.selfGlobalAddr;
    }

    /**
     * Given a Glulx object memory address, return the I6 identifier for that
     * object (reverse lookup of the .dbg object table), or undefined if unknown.
     */
    objectByAddr(addr: number): string | undefined {
        return this.i6AddrToObj.get(addr);
    }

    /** I6 property name → compile-time property number, or undefined if unknown. */
    propNumber(i6Name: string): number | undefined {
        return this.i6PropToNum.get(i6Name);
    }

    /**
     * Decode a set of attribute bytes (7 bytes, indices 0-6) into active
     * attribute names.  Bit layout: attribute N is at byte N>>3, bit 7-(N&7)
     * (MSB of each byte = lowest-numbered attribute in that group).
     */
    activeAttributeNames(attrBytes: number[]): string[] {
        const result: string[] = [];
        for (let n = 0; n < attrBytes.length * 8; n++) {
            const byteIdx = n >> 3;
            const bitMask = 1 << (n & 7);
            if ((attrBytes[byteIdx] & bitMask) !== 0) {
                result.push(this.attrBitMap.get(n) ?? `attr${n}`);
            }
        }
        return result;
    }

    /** Beguile type info by name, or undefined if not in .types. */
    typeInfo(typeName: string): BglTypeInfo | undefined {
        return this.bglTypeMap.get(typeName);
    }

    /**
     * Type info for a specific object instance.  Tries the declared type first
     * (via globalVarType → typeInfo); falls back to per-object sym properties
     * so bare `object` instances still show their members in the Self scope.
     */
    objectTypeInfoFor(objName: string): BglTypeInfo | undefined {
        const typeName = this.globalVarType(objName) ?? objName;
        const typed = this.bglTypeMap.get(typeName);
        if (typed) { return typed; }
        // Fall back to sym-section properties for this specific object
        const symProps = this.objSymProps.get(objName);
        if (symProps && symProps.length > 0) {
            return { name: objName, props: symProps };
        }
        return undefined;
    }

    /** True if typeName is a known Beguile enum. */
    isEnum(typeName: string): boolean {
        return this.enumMap.has(typeName);
    }

    /**
     * Display name for an enum value, or undefined if the numeric value has no
     * named entry.  Returns undefined (not a fallback string) so callers can
     * decide how to handle unmapped values.
     */
    enumValueName(typeName: string, numericValue: number): string | undefined {
        return this.enumMap.get(typeName)?.get(numericValue);
    }

    /**
     * Beguile type for a local variable in a given routine (by routine address).
     * Returns undefined if the .types file wasn't loaded or has no entry.
     */
    localVarType(routineAddr: number, varName: string): BglType | undefined {
        const routine = this.routineContaining(routineAddr) ?? this.routineByAddr(routineAddr);
        if (!routine) { return undefined; }
        return this.routineTyped.get(routine.name)?.get(varName);
    }

    /** Beguile type for a global variable, or undefined if not in .types. */
    globalVarType(varName: string): BglType | undefined {
        return this.globalTyped.get(varName);
    }

    /** Storage location of a local (from .types): `slot` (frame-resident) or `_bglFrm-->N` (spilled). */
    localStorage(routineAddr: number, varName: string): string | undefined {
        const routine = this.routineContaining(routineAddr) ?? this.routineByAddr(routineAddr);
        return routine ? this.routineLocalMeta.get(routine.name)?.get(varName)?.storage : undefined;
    }

    /**
     * Frame-pool word offset for a spilled local (Z-machine >15-local case), or
     * undefined for a frame-resident (`slot`) local. Parses the `_bglFrm-->N` storage.
     * The adapter reads the value at `mem[_bglFrm] + N*WORDSIZE` (needs a runtime word
     * read — the interpreter-phase piece).
     */
    localSpillIndex(routineAddr: number, varName: string): number | undefined {
        const s = this.localStorage(routineAddr, varName);
        const m = s ? /-->(\d+)$/.exec(s) : null;
        return m ? parseInt(m[1], 10) : undefined;
    }

    /**
     * True for a compiler-inserted local carrying the `synthetic` marker (e.g. the
     * `_bglFrm` spill pointer). NOT used to hide anything — per Jim's call the Variables
     * pane conceals nothing — but kept so the presentation layer can annotate/order if
     * desired. `undefined` routine or unmarked local ⇒ false.
     */
    localSynthetic(routineAddr: number, varName: string): boolean {
        const routine = this.routineContaining(routineAddr) ?? this.routineByAddr(routineAddr);
        return !!(routine && this.routineLocalMeta.get(routine.name)?.get(varName)?.synthetic);
    }

    /**
     * Locals spilled to the `_bglFrm` frame-pool (Z-machine >15-local case), each with its
     * word offset into the pool. These do NOT occupy frame slots, so the adapter must read
     * them via `readWord(mem[_bglFrm] + index*WORDSIZE)` rather than from the VM frame.
     * Empty on Glulx (no spilling) and for routines that fit in ≤15 locals.
     */
    spilledLocals(routineAddr: number): { name: string; type: BglType | undefined; index: number }[] {
        const routine = this.routineContaining(routineAddr) ?? this.routineByAddr(routineAddr);
        if (!routine) { return []; }
        const meta  = this.routineLocalMeta.get(routine.name);
        const types = this.routineTyped.get(routine.name);
        if (!meta) { return []; }
        const out: { name: string; type: BglType | undefined; index: number }[] = [];
        for (const [name, m] of meta) {
            const im = /-->(\d+)$/.exec(m.storage);
            if (im) { out.push({ name, type: types?.get(name), index: parseInt(im[1], 10) }); }
        }
        return out;
    }

    // ── Global variable queries ───────────────────────────────────────────────

    /** All global variables declared in the .dbg file. */
    globals(): GlobalInfo[] {
        return this.globalList;
    }

    /**
     * User-visible globals: excludes I6 compiler internals (names with __ or
     * starting with temp_ / sys_).
     */
    userGlobals(): GlobalInfo[] {
        return this.globalList.filter(g =>
            !g.name.includes('__') && !g.name.startsWith('temp_') && !g.name.startsWith('sys_')
        );
    }

    /**
     * User-visible globals that are I6 objects (not scalar global variables).
     * Returns GlobalInfo entries for names declared in the [types] `global` lines
     * whose I6 identifier resolves to an object address in the .dbg object table.
     * The `address` field holds the Glulx memory address of the object itself
     * (the value you'd pass to _bglReadProp).
     */
    userGlobalObjects(): GlobalInfo[] {
        const result: GlobalInfo[] = [];
        for (const [name, _type] of this.globalTyped) {
            if (name.includes('__') || name.startsWith('temp_') || name.startsWith('sys_')) { continue; }
            const addr = this.i6ObjMap.get(name);
            if (addr !== undefined) {
                result.push({ name, address: addr });
            }
        }
        return result;
    }

    /** Look up a routine by exact start address. */
    routineByAddr(addr: number): RoutineInfo | undefined {
        return this.routineMap.get(addr);
    }

    /**
     * Find which routine contains the given bytecode address (range lookup).
     * Used to identify which routine self.pc is inside after a step.
     */
    routineContaining(addr: number): RoutineInfo | undefined {
        // Binary search for the last routine whose startAddr ≤ addr
        let lo = 0, hi = this.routineAddrs.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.routineAddrs[mid] <= addr) { best = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        if (best < 0) return undefined;
        const routine = this.routineMap.get(this.routineAddrs[best])!;
        return addr < routine.endAddr ? routine : undefined;
    }

    /** Resolve a VM address to its I6 line number (main .inf file only, file-index 0). */
    vmAddrToInfLine(addr: number): number | undefined {
        const entry = this.addrToInf.get(addr);
        return entry?.fileIndex === 0 ? entry.line : undefined;
    }

    /** Resolve a VM address to its .inf source location (any included file). */
    vmAddrToInfLocation(addr: number): { path: string; line: number } | undefined {
        const entry = this.addrToInf.get(addr);
        if (!entry) { return undefined; }
        const filePath = this.infFileIndex.get(entry.fileIndex);
        if (!filePath) { return undefined; }
        return { path: filePath, line: entry.line };
    }

    /** Resolve a VM bytecode address to its .bgl source location. */
    vmAddrToBgl(addr: number): BglLocation | undefined {
        const entry = this.addrToInf.get(addr);
        if (!entry) { return undefined; }
        // bgldbg [map] keys are I6 line numbers from the main file (file-index 0) only.
        if (entry.fileIndex !== 0) { return undefined; }
        // Forward resolution is addr → .inf line → .bgl, and a collapsed .inf line may
        // carry several .bgl candidates. The .dbg gives only one line per address, so
        // there is no finer key to disambiguate on here — return the first candidate
        // deterministically. (Post the superposed-anchor fix, genuinely-distinct
        // multi-candidate lines are rare; the reverse direction keeps them all.)
        const locs = this.infToBgl.get(entry.line);
        return locs ? locs[0] : undefined;
    }

    /**
     * Resolve an address to a .bgl location, falling back to the NEAREST PRECEDING mapped line
     * within the same routine when `addr` isn't itself a sequence point. Used for a caller
     * frame's return PC (its call-site resume address), which sits just after the call and is
     * rarely an exact seq-pt. Bounded to `routineContaining(addr)` so it can't bleed into an
     * unrelated routine — and returns undefined if `addr` isn't inside any routine (so a bogus
     * PC yields no navigation rather than a wrong-file jump).
     */
    vmAddrToBglNearest(addr: number): BglLocation | undefined {
        const exact = this.vmAddrToBgl(addr);
        if (exact) { return exact; }
        const routine = this.routineContaining(addr);
        if (!routine) { return undefined; }
        let best = -1;
        for (const [a, entry] of this.addrToInf) {
            if (entry.fileIndex === 0 && a <= addr && a >= routine.startAddr && a > best) { best = a; }
        }
        return best >= 0 ? this.vmAddrToBgl(best) : undefined;
    }

    /**
     * The first mapped sequence-point address of the routine containing `funcAddr` (its entry
     * line). Used to locate a CALLER stack frame by its (reliable) function address — the VM
     * state's per-frame return PC is unreliable (it can point into an unrelated routine, sending
     * a frame click to the wrong file), whereas the routine's own entry is always correct.
     * Returns undefined for a library routine with no mapping in range.
     */
    routineEntryAddr(funcAddr: number): number | undefined {
        const routine = this.routineByAddr(funcAddr) ?? this.routineContaining(funcAddr);
        if (!routine) { return undefined; }
        let first = -1;
        for (const a of this.addrToInf.keys()) {
            if (a >= routine.startAddr && a < routine.endAddr && (first < 0 || a < first)) { first = a; }
        }
        return first >= 0 ? first : undefined;
    }

    /**
     * Reverse-lookup: given a .bgl file+line, return all VM addresses
     * that correspond to it.  Used to translate VS Code breakpoints into
     * addresses to watch for in the interpreter.
     */
    bglToVmAddrs(bglFile: string, bglLine: number): number[] {
        // Step 1: collect all I6 lines (file-index 0) that map to this bgl location.
        const normFile = path.resolve(bglFile);
        const infLines: number[] = [];
        for (const [infLine, locs] of this.infToBgl) {
            // Check EVERY candidate on this .inf line — a breakpoint on a .bgl line that
            // shares an .inf line with another must still bind (the last-write-wins bug).
            if (locs.some(loc => loc.line === bglLine && loc.file === normFile)) {
                infLines.push(infLine);
            }
        }
        // Step 2: collect all VM addresses that map to those I6 lines (main file only).
        const addrs: number[] = [];
        for (const [addr, entry] of this.addrToInf) {
            if (entry.fileIndex === 0 && infLines.includes(entry.line)) {
                addrs.push(addr);
            }
        }
        return addrs;
    }

    /** All unique .bgl source files referenced in the debug map. */
    allBglSourceFiles(): string[] {
        const files = new Set<string>();
        for (const locs of this.infToBgl.values()) {
            for (const loc of locs) { files.add(loc.file); }
        }
        return Array.from(files).sort();
    }

    /**
     * True when `filePath` appears as a source file in the [map] section of the
     * .bgldbg bundle. Includes both .bgl files (normal Beguile mode) and .inf
     * files when the original .inf is the source (i.e. .inf-as-input mode).
     * Used by the debug adapter to route setBreakpoints through the bgl→VM map
     * rather than the I6 line→VM map for any source that has Beguile-derived
     * code, regardless of file extension.
     */
    isBglSource(filePath: string): boolean {
        const norm = path.resolve(filePath);
        for (const locs of this.infToBgl.values()) {
            if (locs.some(loc => loc.file === norm)) return true;
        }
        return false;
    }

    /** All unique .inf source files referenced in the debug map (by file-index). */
    allInfSourceFiles(): string[] {
        const used = new Set<number>();
        for (const entry of this.addrToInf.values()) { used.add(entry.fileIndex); }
        return Array.from(used)
            .map(i => this.infFileIndex.get(i))
            .filter((p): p is string => p !== undefined)
            .sort();
    }

    /** All VM addresses that have any sequence point (for I6-level stepping). */
    allVmAddrs(): number[] {
        return Array.from(this.addrToInf.keys());
    }

    /** All file-indexes that resolve to the same physical file. The I6 compiler emits a fresh
     * <given-path> (→ new file-index) every time it re-enters a file, so ONE physical source (e.g.
     * a library .h re-entered many times) owns several indexes — and typically only ONE of them
     * actually carries the sequence-points. Matching a single index silently drops the code, so any
     * path→addr lookup must union across all of them. */
    private fileIndexesForPath(filePath: string): Set<number> {
        const norm = path.resolve(filePath);
        const idxs = new Set<number>();
        for (const [idx, p] of this.infFileIndex) {
            if (path.resolve(p) === norm) { idxs.add(idx); }
        }
        return idxs;
    }

    /** All VM addresses in a specific .inf file (for I6 step-over). */
    vmAddrsForInfFile(filePath: string): number[] {
        const targetIdxs = this.fileIndexesForPath(filePath);
        if (targetIdxs.size === 0) { return []; }
        const result: number[] = [];
        for (const [addr, entry] of this.addrToInf) {
            if (targetIdxs.has(entry.fileIndex)) { result.push(addr); }
        }
        return result;
    }

    /** All VM addresses that map to a .bgl line (for .bgl-level stepping). */
    allMappedVmAddrs(): number[] {
        const result: number[] = [];
        for (const [addr, entry] of this.addrToInf) {
            if (entry.fileIndex === 0 && this.infToBgl.has(entry.line)) {
                result.push(addr);
            }
        }
        return result;
    }

    /** All VM addresses sharing the same .inf file+line (skip set for I6 stepping). */
    vmAddrsForInfLine(infLine: number, infFilePath?: string): number[] {
        const result: number[] = [];
        // Resolve which file-index(es) to match. A physical file can own several indexes (see
        // fileIndexesForPath) — matching only the first drops the one that carries the seq-points,
        // so library-file breakpoints never bind. Union across all of them.
        let targetIdxs: Set<number>;
        if (infFilePath) {
            targetIdxs = this.fileIndexesForPath(infFilePath);
            if (targetIdxs.size === 0) { targetIdxs = new Set([0]); } // fall back to main .inf
        } else {
            targetIdxs = new Set([0]); // default: main transpiled .inf
        }
        for (const [addr, entry] of this.addrToInf) {
            if (targetIdxs.has(entry.fileIndex) && entry.line === infLine) {
                result.push(addr);
            }
        }
        return result;
    }
}
