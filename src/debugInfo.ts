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
    /** infLine → bgl location */
    private infToBgl    = new Map<number, BglLocation>();
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
    /** global variable name → BglType (from .types) */
    private globalTyped  = new Map<string, BglType>();
    /** Beguile enum name → (numeric value → display name) */
    private enumMap      = new Map<string, Map<number, string>>();
    /** I6 attribute bit number → attribute name (from .dbg <attribute> entries) */
    private attrBitMap   = new Map<number, string>();
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
                        this.infToBgl.set(infLine, { file: path.resolve(parts[1]), line: bglLine });
                    }
                    break;
                }
                case 'sym':
                    // Reserved for future use — skip
                    break;
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
                            this.routineTyped.set(parts[1], currentLocals);
                            break;
                        case 'local':
                            if (currentLocals && parts.length >= 3) {
                                currentLocals.set(parts[1], parts[2]);
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
    }

    private loadDbg(dbgPath: string): void {
        const xml = fs.readFileSync(dbgPath, 'utf8');

        // Read i6IncludePaths from the generated .inf file's !% +include_path= ICL directive.
        // These are the directories where the I6 compiler resolves included library files.
        const infPath = dbgPath.replace(/\.dbg$/, '');
        const i6SearchDirs: string[] = [path.dirname(dbgPath)];
        try {
            const infContent = fs.readFileSync(infPath, 'utf8');
            for (const line of infContent.split('\n')) {
                const m2 = /^!%\s*\+include_path=(.+)/.exec(line.trim());
                if (m2) {
                    for (const p of m2[1].split(',')) {
                        const dir = p.trim();
                        if (dir) { i6SearchDirs.push(dir); }
                    }
                    break;
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
        return this.infToBgl.get(entry.line);
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
        for (const [infLine, loc] of this.infToBgl) {
            if (loc.line === bglLine && loc.file === normFile) {
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
        for (const loc of this.infToBgl.values()) { files.add(loc.file); }
        return Array.from(files).sort();
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

    /** All VM addresses in a specific .inf file (for I6 step-over). */
    vmAddrsForInfFile(filePath: string): number[] {
        let targetIdx: number | undefined;
        for (const [idx, p] of this.infFileIndex) {
            if (p === filePath) { targetIdx = idx; break; }
        }
        if (targetIdx === undefined) { return []; }
        const result: number[] = [];
        for (const [addr, entry] of this.addrToInf) {
            if (entry.fileIndex === targetIdx) { result.push(addr); }
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
        // Resolve which file-index to match
        let targetFileIndex = 0; // default: main transpiled .inf
        if (infFilePath) {
            const norm = path.resolve(infFilePath);
            for (const [idx, p] of this.infFileIndex) {
                if (path.resolve(p) === norm) { targetFileIndex = idx; break; }
            }
        }
        for (const [addr, entry] of this.addrToInf) {
            if (entry.fileIndex === targetFileIndex && entry.line === infLine) {
                result.push(addr);
            }
        }
        return result;
    }
}
