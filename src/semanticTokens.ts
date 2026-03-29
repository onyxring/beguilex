import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';


// Token types and modifiers exposed to VSCode
// 'type' is used for class/object name usages (non-declaration sites) so
// themes that don't style 'class' usage separately still show a color.
const tokenTypes = ['class', 'enum', 'enumMember', 'variable', 'property', 'method', 'type', 'function'];
const tokenModifiers = ['declaration'];
export const tokenLegend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// Type declaration: (optional modifiers) (keyword) (name)
const DECL_RE = /^\s*(?:extern\s+|emitter\s+|alias\s+)*\b(class|object|enum|bnum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Single-line extern declaration: extern [const] <typeKeyword> <name> [as <alias>];
// Handles verb, grammarToken, attribute, int, var, and extern class instances.
const EXTERN_SINGLE_RE = /^\s*extern\s+(const\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:as\s+[a-zA-Z_][a-zA-Z0-9_]*)?\s*;/;

// Top-level const declaration: const <type> <name> = ...
const CONST_DECL_RE = /^\s*const\s+([a-zA-Z_][a-zA-Z0-9_<>]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|;)/;

// Member declaration inside a class/object body:
// optional modifiers, return type, member name, then '(' (method) or ';' (property)
const MEMBER_DECL_RE = /^\s*(?:(?:extern|emitter|replace|const|array)\s+)*\b([a-zA-Z_][a-zA-Z0-9_<>]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=\s*(?:\{[^}]*\}|[^;{(]*))?(\(|;)/;

// Body-opener for collectMembers — broader than DECL_RE: also matches
// 'extend class Foo' so that members added via extension are included.
// Positive lookahead (?=\s*[{:]) requires the name to be immediately followed
// by a brace or colon (type body / inheritance), preventing false matches on
// method/property declarations like `emitter object operator = (...)` or
// `emitter object parent()`. A negative lookahead was tried first but caused
// backtracking: the engine would shrink the name capture (e.g. `operato`)
// until the lookahead passed at a mid-identifier position.
const BODY_OPENER_RE = /^\s*(?:extern\s+|emitter\s+|alias\s+|extend\s+)*\b(class|object)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*[{:])/;

// User-defined type instance body opener: `TypeName instanceName {`
// Used as a fallback when BODY_OPENER_RE doesn't match but the first identifier
// is a known user-defined type (e.g. `worldObject foyer {`).
const TYPED_INSTANCE_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:<[^>]*>)?\s+([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*[{:])/;

// Bare inherited property assignment inside a class/object body: `identifier =` or `identifier[`
// No preceding type keyword — the property is inherited from a parent type.
const BARE_ASSIGN_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|\[)/;

// #include <name> or #include "path"  (not #includeI6 — those are raw I6 files)
const INCLUDE_RE = /^\s*#?include\s*(?:<([^>]+)>|"([^"]+)")/;

// Beguile reserved words — never emit semantic tokens for these even if a
// library happens to declare a type with the same name (e.g. `class object`).
// Grammar rules already color them; semantic tokens must not override that.
const BEGUILE_KEYWORDS = new Set([
    // type declaration keywords
    'class', 'enum', 'bnum', 'verb', 'grammar', 'attribute',
    // declaration modifiers
    'extern', 'extend', 'emitter', 'replace', 'const', 'alias',
    // primitive types
    'int', 'bool', 'string', 'char', 'void', 'var', 'array', 'func', 'eBool', 'dictionaryWord',
    // control flow
    'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
    'switch', 'case', 'default', 'new', 'delete', 'this', 'null', 'true', 'false',
    // beguile special
    'rtrue', 'rfalse',
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function stripComments(line: string): string {
    line = line.replace(/\/\*.*?\*\//g, match => ' '.repeat(match.length));
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.substring(0, lc);
    return line;
}

function netBraceChange(line: string): number {
    let count = 0;
    let inStr = false;
    let prev = '';
    for (const ch of line) {
        if (ch === '"' && prev !== '\\') inStr = !inStr;
        if (!inStr) {
            if (ch === '{') count++;
            else if (ch === '}') count--;
        }
        prev = ch;
    }
    return count;
}

function stringRanges(line: string): [number, number][] {
    const ranges: [number, number][] = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === '"') {
            const isInterpolated = i > 0 && line[i - 1] === '$';
            if (isInterpolated) {
                // Interpolated string $"...{expr}...": mark literal segments as string ranges;
                // skip {expr} regions (they are code), but mark sub-strings inside them.
                i++; // past opening "
                let segStart = i;
                let braceDepth = 0;
                while (i < line.length) {
                    if (braceDepth === 0) {
                        if (line[i] === '\\') {
                            i += 2; continue;   // \{ etc. — not a real brace
                        } else if (line[i] === '{') {
                            if (i > segStart) ranges.push([segStart, i - 1]);
                            braceDepth = 1; i++; continue;
                        } else if (line[i] === '"') {
                            ranges.push([segStart, i]); i++; break; // end of interpolated string
                        }
                    } else {
                        // Inside {expr}: track nesting; mark any sub-string literals as ranges
                        if (line[i] === '"') {
                            const subStart = i++;
                            while (i < line.length && line[i] !== '"') {
                                if (line[i] === '\\') i++;
                                i++;
                            }
                            ranges.push([subStart, i]); // i is at closing "
                        } else if (line[i] === '{') {
                            braceDepth++;
                        } else if (line[i] === '}') {
                            if (--braceDepth === 0) segStart = i + 1;
                        }
                    }
                    i++;
                }
            } else {
                // Regular string
                const start = i++;
                while (i < line.length && line[i] !== '"') {
                    if (line[i] === '\\') i++;
                    i++;
                }
                ranges.push([start, i]);
                i++;
            }
        } else {
            i++;
        }
    }
    return ranges;
}

function inRange(col: number, ranges: [number, number][]): boolean {
    return ranges.some(([s, e]) => col >= s && col <= e);
}

function reEsc(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Data structures ────────────────────────────────────────────────────────

interface TypeInfo {
    name: string;
    tokenType: 'class' | 'enum' | 'enumMember' | 'variable';
    declFile: string;
    declLine: number;
    declCol: number;
}

interface MemberInfo {
    name: string;
    className: string;      // which class/object declared this member
    tokenType: 'method' | 'property';
    params: string;         // raw param string, e.g. "string s, int n" (empty for properties)
    returnType: string;     // e.g. "void", "int", "char"
    declFile: string;
    declLine: number;
    declCol: number;
}

interface FunctionInfo {
    name: string;
    params: string;
    returnType: string;
    declFile: string;
    declLine: number;
    declCol: number;
}

// ── Declaration collectors ─────────────────────────────────────────────────

function collectDeclarations(lines: string[], seen: Set<string>, filePath: string, typeNames?: Set<string>): TypeInfo[] {
    const types: TypeInfo[] = [];
    // knownTypes accumulates class names seen so far in this file so that
    // user-defined type instance declarations later in the same file are recognised
    // (e.g. `worldObject foyer {` after `alias class worldObject : object {`).
    const knownTypes = typeNames ?? new Set<string>();
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripComments(lines[i]);

        // Only collect top-level (depth 0) declarations — property declarations
        // inside class/object bodies look identical to type declarations otherwise
        // (e.g. "object parent = selfobj;" would match DECL_RE at depth 1).
        if (depth !== 0) {
            depth += netBraceChange(stripped);
            if (depth < 0) depth = 0;
            continue;
        }

        const m  = DECL_RE.exec(stripped);
        const em = m ? null : EXTERN_SINGLE_RE.exec(stripped);
        const cm = (!m && !em) ? CONST_DECL_RE.exec(stripped) : null;
        // Fallback: user-defined type instance, e.g. `worldObject foyer {`
        const tm = (!m && !em && !cm) ? TYPED_INSTANCE_RE.exec(stripped) : null;
        const isTypedInstance = !!tm && knownTypes.has(tm[1]) && !BEGUILE_KEYWORDS.has(tm[1]);

        if (!m && !em && !cm && !isTypedInstance) {
            depth += netBraceChange(stripped);
            continue;
        }

        const name = m ? m[2] : em ? em[3] : cm ? cm[2] : tm![2];
        if (!seen.has(name)) {
            seen.add(name);
            let tokenType: 'class' | 'enum' | 'enumMember' | 'variable';
            let col: number;
            if (isTypedInstance) {
                // User-defined type instance — same visual treatment as `object` instances
                tokenType = 'variable';
                col = lines[i].indexOf(name, lines[i].indexOf(tm![1]) + tm![1].length);
            } else if (m) {
                const keyword = m[1];
                // If the line has `extern` and ends with `;` it is an extern instance
                // declaration (e.g. `extern object selfobj;`), not a type definition.
                // Use `variable` for object/class keywords and `enumMember` for enums
                // so that instances are differentiated from type names visually.
                const isExternInstance = /\bextern\b/.test(stripped) && stripped.trimEnd().endsWith(';');
                if (keyword === 'enum' || keyword === 'bnum') {
                    tokenType = isExternInstance ? 'enumMember' : 'enum';
                } else if (keyword === 'object') {
                    // `object` always declares an instance (even with an inline body),
                    // never a type definition — use variable color to match extern instances.
                    tokenType = 'variable';
                } else {
                    // `class` is a true type definition — add to knownTypes so that
                    // instances of this class later in the file are also recognised.
                    tokenType = isExternInstance ? 'variable' : 'class';
                    if (tokenType === 'class') knownTypes.add(name);
                }
                col = lines[i].indexOf(name, lines[i].search(/\b(?:class|object|enum|bnum)\b/) + keyword.length);
            } else if (cm) {
                // Top-level const — always a named constant
                tokenType = 'enumMember';
                col = lines[i].lastIndexOf(name);
            } else {
                const isConst = !!em![1];
                const typeKw  = em![2];
                tokenType = (typeKw === 'grammarToken' || typeKw === 'attribute' || isConst)
                    ? 'enumMember' : 'variable';
                col = lines[i].lastIndexOf(name);
            }
            types.push({ name, tokenType, declFile: filePath, declLine: i, declCol: col >= 0 ? col : 0 });
        }

        depth += netBraceChange(stripped);
        if (depth < 0) depth = 0;
    }
    return types;
}

// ── Enum value collection ──────────────────────────────────────────────────

function _parseEnumBodySegment(body: string, values: string[]): void {
    for (const tok of body.split(',')) {
        const name = tok.split('=')[0].trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) values.push(name);
    }
}

// Parse all enum/bnum bodies in `lines` and accumulate into `out` (skips already-known enums).
function collectEnumValues(lines: string[], out: Map<string, string[]>): void {
    const ENUM_OPEN_RE = /^\s*(?:extern\s+)?(?:enum|bnum)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/;
    let currentEnum: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripComments(lines[i]);
        if (currentEnum === null) {
            const m = ENUM_OPEN_RE.exec(stripped);
            if (m && !out.has(m[1])) {
                currentEnum = m[1];
                out.set(currentEnum, []);
                const afterBrace = stripped.slice(m.index + m[0].length);
                const closeIdx = afterBrace.indexOf('}');
                _parseEnumBodySegment(closeIdx !== -1 ? afterBrace.slice(0, closeIdx) : afterBrace, out.get(currentEnum)!);
                if (closeIdx !== -1) currentEnum = null;
            }
        } else {
            const closeIdx = stripped.indexOf('}');
            _parseEnumBodySegment(closeIdx !== -1 ? stripped.slice(0, closeIdx) : stripped, out.get(currentEnum)!);
            if (closeIdx !== -1) currentEnum = null;
        }
    }
}

function collectMembers(lines: string[], seen: Set<string>, filePath: string, typeNames?: Set<string>): MemberInfo[] {
    const members: MemberInfo[] = [];
    let depth = 0;
    let classBodyDepth = -1;
    let i6Depth = -1;
    let currentClassName = '';

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComments(raw);

        const i6Open = /^\s*#i6(?:raw)?\s*\{/.test(stripped);
        if (i6Open && i6Depth === -1) i6Depth = depth;

        const delta = netBraceChange(stripped);

        // Determine if this line opens a class/object body.
        // First try the keyword form (class/object); then fall back to a
        // user-defined type instance form (e.g. `worldObject foyer {`) when
        // a typeNames set is provided.
        let bodyOpenerKw: string | null = null;
        let bodyOpenerName: string | null = null;
        const bm = BODY_OPENER_RE.exec(stripped);
        if (bm) {
            bodyOpenerKw = bm[1]; bodyOpenerName = bm[2];
        } else if (typeNames) {
            const tm = TYPED_INSTANCE_RE.exec(stripped);
            if (tm && typeNames.has(tm[1]) && !BEGUILE_KEYWORDS.has(tm[1])) {
                bodyOpenerKw = 'object'; bodyOpenerName = tm[2];
            }
        }

        // Check for members BEFORE updating depth — a member lives at
        // classBodyDepth, measured at the START of the line (before any
        // braces on this line are counted). Checking after the update would
        // cause method declarations like `int hello(){` (delta=1) to be
        // checked at depth+1, missing them entirely.
        if (classBodyDepth !== -1 && depth === classBodyDepth && i6Depth === -1 && !bodyOpenerKw) {
            const mm = MEMBER_DECL_RE.exec(stripped);
            if (mm) {
                const name = mm[2];
                const isMethod = mm[3] === '(';
                if (!seen.has(name)) {
                    seen.add(name);
                    const typeStr = mm[1];
                    const returnType = typeStr;
                    const typeIdx = raw.search(new RegExp('\\b' + reEsc(typeStr) + '\\b'));
                    const col = typeIdx >= 0 ? raw.indexOf(name, typeIdx + typeStr.length) : raw.indexOf(name);
                    let params = '';
                    if (isMethod) {
                        const openParen = mm.index + mm[0].length - 1; // position of '(' in stripped
                        const closeParen = stripped.indexOf(')', openParen + 1);
                        params = closeParen > openParen ? stripped.substring(openParen + 1, closeParen).trim() : '';
                    }
                    members.push({ name, className: currentClassName, tokenType: isMethod ? 'method' : 'property', params, returnType, declFile: filePath, declLine: i, declCol: col >= 0 ? col : 0 });
                }
            }
        }

        // Update classBodyDepth if this line opens a class/object body
        if (bodyOpenerKw && delta > 0 && i6Depth === -1) {
            classBodyDepth = depth + delta;
            currentClassName = bodyOpenerName!;
        }

        if (i6Depth !== -1) {
            depth += delta;
            if (depth <= i6Depth) i6Depth = -1;
        } else {
            depth += delta;
        }

        if (classBodyDepth !== -1 && depth < classBodyDepth) {
            classBodyDepth = -1;
            currentClassName = '';
        }
    }
    return members;
}

// Scan a single file for ALL member declaration positions without deduplication.
// Used to build memberDeclByLine so that the same method name declared in
// multiple classes (e.g. `before` in both `bar` and `cloak`) gets highlighted
// at every declaration site, not just the first one seen.
interface DeclPos { line: number; col: number; name: string; tokenType: 'method' | 'property'; }
function findMemberDeclPositions(lines: string[], typeNames?: Set<string>): DeclPos[] {
    const result: DeclPos[] = [];
    let depth = 0;
    let classBodyDepth = -1;
    let i6Depth = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComments(raw);

        const i6Open = /^\s*#i6(?:raw)?\s*\{/.test(stripped);
        if (i6Open && i6Depth === -1) i6Depth = depth;

        const delta = netBraceChange(stripped);

        let bodyOpenerKw: string | null = null;
        const bm = BODY_OPENER_RE.exec(stripped);
        if (bm) {
            bodyOpenerKw = bm[1];
        } else if (typeNames) {
            const tm = TYPED_INSTANCE_RE.exec(stripped);
            if (tm && typeNames.has(tm[1]) && !BEGUILE_KEYWORDS.has(tm[1])) {
                bodyOpenerKw = 'object';
            }
        }

        if (classBodyDepth !== -1 && depth === classBodyDepth && i6Depth === -1 && !bodyOpenerKw) {
            const mm = MEMBER_DECL_RE.exec(stripped);
            if (mm) {
                const name = mm[2];
                const isMethod = mm[3] === '(';
                const typeStr = mm[1];
                const typeIdx = raw.search(new RegExp('\\b' + reEsc(typeStr) + '\\b'));
                const col = typeIdx >= 0 ? raw.indexOf(name, typeIdx + typeStr.length) : raw.indexOf(name);
                result.push({ line: i, col: col >= 0 ? col : 0, name, tokenType: isMethod ? 'method' : 'property' });
            } else {
                // Bare inherited property assignment: `attributes = {...}` — no type keyword
                const bm2 = BARE_ASSIGN_RE.exec(stripped);
                if (bm2) {
                    const name = bm2[1];
                    const col = raw.indexOf(name);
                    result.push({ line: i, col: col >= 0 ? col : 0, name, tokenType: 'property' });
                }
            }
        }

        if (bodyOpenerKw && delta > 0 && i6Depth === -1) {
            classBodyDepth = depth + delta;
        }

        if (i6Depth !== -1) {
            depth += delta;
            if (depth <= i6Depth) i6Depth = -1;
        } else {
            depth += delta;
        }

        if (classBodyDepth !== -1 && depth < classBodyDepth) {
            classBodyDepth = -1;
        }
    }
    return result;
}

function collectFunctions(lines: string[], seen: Set<string>, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    let depth = 0;
    let i6Depth = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComments(raw);

        const i6Open = /^\s*#i6(?:raw)?\s*\{/.test(stripped);
        if (i6Open && i6Depth === -1) i6Depth = depth;

        const delta = netBraceChange(stripped);
        const declMatch = BODY_OPENER_RE.exec(stripped);

        // Top-level functions: depth 0, not inside i6, not a type declaration line
        if (depth === 0 && i6Depth === -1 && !declMatch) {
            const mm = MEMBER_DECL_RE.exec(stripped);
            if (mm && mm[3] === '(') {
                const name = mm[2];
                if (!seen.has(name)) {
                    seen.add(name);
                    const typeStr = mm[1];
                    const returnType = typeStr;
                    const typeIdx = raw.search(new RegExp('\\b' + reEsc(typeStr) + '\\b'));
                    const col = typeIdx >= 0 ? raw.indexOf(name, typeIdx + typeStr.length) : raw.indexOf(name);
                    const openParen = mm.index + mm[0].length - 1; // position of '(' in stripped
                    const closeParen = stripped.indexOf(')', openParen + 1);
                    const params = closeParen > openParen ? stripped.substring(openParen + 1, closeParen).trim() : '';
                    functions.push({ name, params, returnType, declFile: filePath, declLine: i, declCol: col >= 0 ? col : 0 });
                }
            }
        }

        if (i6Depth !== -1) {
            depth += delta;
            if (depth <= i6Depth) i6Depth = -1;
        } else {
            depth += delta;
        }
    }
    return functions;
}

// ── Include resolution ─────────────────────────────────────────────────────

// Resolved-path cache — avoids repeated synchronous fs.existsSync scans for
// the same include name across multiple document versions or provider calls.
const resolvedPathCache = new Map<string, string | null>();

// Walk every workspace folder and return the first existing path that matches
// one of the candidate sub-paths (checked synchronously).
function findInWorkspaceFolders(...subPaths: string[]): string | null {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const sub of subPaths) {
            const candidate = path.join(folder.uri.fsPath, sub);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

// Locate a system include (<name>) by searching workspace folders synchronously.
function findSystemInclude(name: string): string | null {
    if (resolvedPathCache.has(name)) return resolvedPathCache.get(name)!;

    const withExt = name.endsWith('.bgl') ? name : `${name}.bgl`;

    const result = findInWorkspaceFolders(
        path.join('beguile', 'beguiLib', withExt),
        path.join('inform6', 'beguilib', withExt),
        path.join('beguiLib', withExt),
        withExt
    );
    resolvedPathCache.set(name, result);
    return result;
}

// Locate _beguileCore.bgl using the configured libraryPath setting first,
// then falling back to a synchronous workspace search.
function findCoreLibrary(): string | null {
    const config  = vscode.workspace.getConfiguration('beguiler');
    const libPath = config.get<string>('libraryPath');

    if (libPath) {
        const base      = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const resolved  = path.isAbsolute(libPath) ? libPath : path.join(base, libPath);
        const candidate = path.join(resolved, '_beguileCore.bgl');
        if (fs.existsSync(candidate)) return candidate;
    }

    return findSystemInclude('_beguileCore');
}

// Recursively walk #include directives, collecting declarations and members
// from each referenced file. `visited` prevents cycles.
function collectFromIncludes(
    lines: string[],
    currentFilePath: string,
    visited: Set<string>,
    typeSeen: Set<string>,
    memberSeen: Set<string>,
    funcSeen: Set<string>,
    allTypes: TypeInfo[],
    allMembers: MemberInfo[],
    allFunctions: FunctionInfo[],
    typeNames: Set<string>,
    enumValuesByEnum: Map<string, string[]>
): void {
    for (const line of lines) {
        const m = INCLUDE_RE.exec(line);
        if (!m) continue;

        const isSystem = !!m[1];
        const name = m[1] ?? m[2];

        let resolved: string | null = null;
        if (isSystem) {
            resolved = findSystemInclude(name);
        } else {
            const candidate = path.resolve(path.dirname(currentFilePath), name);
            resolved = fs.existsSync(candidate) ? candidate : null;
        }

        if (!resolved || visited.has(resolved)) continue;
        visited.add(resolved);

        let content: string;
        try { content = fs.readFileSync(resolved, 'utf8'); }
        catch { continue; }

        const fileLines = content.split('\n');
        const newTypes = collectDeclarations(fileLines, typeSeen, resolved, typeNames);
        allTypes.push(...newTypes);
        for (const t of newTypes) typeNames.add(t.name);
        allMembers.push(...collectMembers(fileLines, memberSeen, resolved, typeNames));
        allFunctions.push(...collectFunctions(fileLines, funcSeen, resolved));
        collectEnumValues(fileLines, enumValuesByEnum);
        collectFromIncludes(fileLines, resolved, visited, typeSeen, memberSeen, funcSeen, allTypes, allMembers, allFunctions, typeNames, enumValuesByEnum);
    }
}

// ── Shared symbol collection ───────────────────────────────────────────────

export interface SymbolCollection {
    allTypes:        TypeInfo[];
    allMembers:      MemberInfo[];
    allFunctions:    FunctionInfo[];
    membersByClass:  Map<string, MemberInfo[]>;
    enumValuesByEnum: Map<string, string[]>;
}

// Cache computed SymbolCollections keyed by `filePath@version` so concurrent
// provider calls for the same document version share one result.
const symbolCache = new Map<string, SymbolCollection>();

export async function collectAllSymbols(document: vscode.TextDocument): Promise<SymbolCollection> {
    const key = `${document.uri.fsPath}@${document.version}`;
    if (!symbolCache.has(key)) {
        symbolCache.set(key, _collectAllSymbols(document));
    }
    return symbolCache.get(key)!;
}

function _collectAllSymbols(document: vscode.TextDocument): SymbolCollection {
    const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

    const typeSeen:   Set<string> = new Set();
    const memberSeen: Set<string> = new Set();
    const funcSeen:   Set<string> = new Set();
    // Accumulated set of all known type names — passed to collectMembers so that
    // user-defined type instance bodies (e.g. `worldObject foyer {`) are recognised.
    const typeNames:  Set<string> = new Set();

    const docPath = document.uri.fsPath;
    const allTypes:       TypeInfo[]          = collectDeclarations(lines, typeSeen, docPath, typeNames);
    for (const t of allTypes) typeNames.add(t.name);
    const allMembers:     MemberInfo[]        = collectMembers(lines, memberSeen, docPath, typeNames);
    const allFunctions:   FunctionInfo[]      = collectFunctions(lines, funcSeen, docPath);
    const enumValuesByEnum: Map<string, string[]> = new Map();
    collectEnumValues(lines, enumValuesByEnum);

    const visited = new Set<string>([docPath]);
    const coreFile = findCoreLibrary();
    if (coreFile && !visited.has(coreFile)) {
        visited.add(coreFile);
        try {
            const coreLines = fs.readFileSync(coreFile, 'utf8').split('\n');
            const coreTypes = collectDeclarations(coreLines, typeSeen, coreFile, typeNames);
            allTypes.push(...coreTypes);
            for (const t of coreTypes) typeNames.add(t.name);
            allMembers.push(...collectMembers(coreLines, memberSeen, coreFile, typeNames));
            allFunctions.push(...collectFunctions(coreLines, funcSeen, coreFile));
            collectEnumValues(coreLines, enumValuesByEnum);
            collectFromIncludes(coreLines, coreFile, visited, typeSeen, memberSeen, funcSeen, allTypes, allMembers, allFunctions, typeNames, enumValuesByEnum);
        } catch { /* core not found */ }
    }

    collectFromIncludes(lines, document.uri.fsPath, visited, typeSeen, memberSeen, funcSeen, allTypes, allMembers, allFunctions, typeNames, enumValuesByEnum);

    // Build membersByClass map by grouping allMembers by className
    const membersByClass = new Map<string, MemberInfo[]>();
    for (const m of allMembers) {
        const list = membersByClass.get(m.className) ?? [];
        list.push(m);
        membersByClass.set(m.className, list);
    }

    return { allTypes, allMembers, allFunctions, membersByClass, enumValuesByEnum };
}  // end _collectAllSymbols

// ── Semantic tokens provider ───────────────────────────────────────────────

export class BeguileSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(tokenLegend);
        const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

        const { allTypes, allMembers, allFunctions } = await collectAllSymbols(document);

        if (allTypes.length === 0 && allMembers.length === 0 && allFunctions.length === 0) return builder.build();

        // ── Build lookup maps ──────────────────────────────────────────────
        // Exclude reserved keywords from semantic type matching — they get
        // grammar colors and must not be overridden by semantic tokens.
        const filteredTypes = allTypes.filter(t => !BEGUILE_KEYWORDS.has(t.name));

        const filteredMembers   = allMembers.filter(m => !BEGUILE_KEYWORDS.has(m.name));
        const filteredFunctions = allFunctions.filter(f => !BEGUILE_KEYWORDS.has(f.name));

        const typeMap     = new Map<string, TypeInfo>(filteredTypes.map(t => [t.name, t]));
        const memberMap   = new Map<string, MemberInfo>(filteredMembers.map(m => [m.name, m]));
        const functionMap = new Map<string, FunctionInfo>(filteredFunctions.map(f => [f.name, f]));

        const typePattern = filteredTypes.length > 0
            ? new RegExp(`\\b(${filteredTypes.map(t => reEsc(t.name)).join('|')})\\b`, 'g')
            : null;

        const memberPattern = filteredMembers.length > 0
            ? new RegExp(`\\.(${filteredMembers.map(m => reEsc(m.name)).join('|')})\\b`, 'g')
            : null;

        const functionPattern = filteredFunctions.length > 0
            ? new RegExp(`\\b(${filteredFunctions.map(f => reEsc(f.name)).join('|')})\\b`, 'g')
            : null;

        // Member declaration sites — built from a no-dedup scan of the current
        // document so that the same method name in multiple classes (e.g. `before`
        // in both `bar` and `cloak`) gets highlighted at every declaration site.
        const typeNameSet = new Set(allTypes.map(t => t.name));
        const memberDeclByLine = new Map<number, DeclPos[]>();
        for (const decl of findMemberDeclPositions(lines, typeNameSet)) {
            if (memberMap.has(decl.name) && !BEGUILE_KEYWORDS.has(decl.name)) {
                const list = memberDeclByLine.get(decl.line) ?? [];
                list.push(decl);
                memberDeclByLine.set(decl.line, list);
            }
        }

        // ── Emit tokens line by line (current document only) ──────────────
        // Tokens within a line are collected into a per-line array, sorted by
        // col, and deduplicated before pushing — SemanticTokensBuilder requires
        // strictly ascending (line, col) order across all push() calls.
        type PendingToken = [col: number, len: number, typeIdx: number, mod: number];

        let inBlockComment = false;  // tracks multi-line /* */ block comment state

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const raw = lines[lineIdx];

            // ── Multi-line block comment tracking ────────────────────────
            let codeLine = raw;
            if (inBlockComment) {
                const closeIdx = raw.indexOf('*/');
                if (closeIdx === -1) continue;   // entire line is inside the block comment
                inBlockComment = false;
                codeLine = raw.slice(closeIdx + 2);  // only the code after */
            }

            if (/^\s*\/\//.test(codeLine)) continue;
            if (INCLUDE_RE.test(codeLine)) continue;  // include path — not code

            // stripComments removes same-line /* */ pairs and truncates at //.
            // If an unclosed /* still remains after that, a block comment opens
            // on this line and continues onto subsequent lines.
            let stripped = stripComments(codeLine);
            const blockOpen = stripped.indexOf('/*');
            if (blockOpen !== -1) {
                inBlockComment = true;
                stripped = stripped.slice(0, blockOpen);
            }

            const strRanges = stringRanges(stripped);
            const pending: PendingToken[] = [];

            const emit = (col: number, len: number, typeName: string, mod: number) => {
                const idx = tokenTypes.indexOf(typeName);
                if (idx >= 0) pending.push([col, len, idx, mod]);
            };

            // Type name tokens
            if (typePattern) {
                typePattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = typePattern.exec(stripped)) !== null) {
                    const col = m.index;
                    if (inRange(col, strRanges)) continue;
                    if (col > 0 && stripped[col - 1] === '.') continue;  // skip .TypeName (dictionary word context)
                    const info = typeMap.get(m[1])!;
                    const isDecl = lineIdx === info.declLine && col === info.declCol;
                    const emitType = isDecl ? info.tokenType
                        : (info.tokenType === 'class' || info.tokenType === 'enum') ? 'type'
                        : info.tokenType;
                    emit(col, m[1].length, emitType,
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0);
                }
            }

            // Function tokens: bare 'name' not preceded by '.' (not a member call)
            if (functionPattern) {
                functionPattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = functionPattern.exec(stripped)) !== null) {
                    const col = m.index;
                    if (inRange(col, strRanges)) continue;
                    if (col > 0 && stripped[col - 1] === '.') continue;
                    const info = functionMap.get(m[1])!;
                    const isDecl = lineIdx === info.declLine && col === info.declCol;
                    emit(col, m[1].length, 'function',
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0);
                }
            }

            // Member declaration tokens (bare name at declaration site — no dot prefix)
            const memberDecls = memberDeclByLine.get(lineIdx);
            if (memberDecls) {
                for (const decl of memberDecls) {
                    if (!inRange(decl.col, strRanges)) {
                        emit(decl.col, decl.name.length, decl.tokenType,
                            1 << tokenModifiers.indexOf('declaration'));
                    }
                }
            }

            // Member usage tokens: '.memberName' after an alphanumeric or ')'
            if (memberPattern) {
                memberPattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = memberPattern.exec(stripped)) !== null) {
                    const dotCol  = m.index;
                    const nameCol = dotCol + 1;
                    const name    = m[1];
                    const preceding = dotCol > 0 ? stripped[dotCol - 1] : '';
                    if (!/[a-zA-Z0-9_)]/.test(preceding)) continue;
                    if (inRange(nameCol, strRanges)) continue;
                    const info = memberMap.get(name)!;
                    emit(nameCol, name.length, info.tokenType, 0);
                }
            }

            // Sort by col, deduplicate overlapping ranges, then push to builder
            pending.sort((a, b) => a[0] - b[0]);
            let lastEnd = -1;
            for (const [col, len, typeIdx, mod] of pending) {
                if (col >= lastEnd) {
                    builder.push(lineIdx, col, len, typeIdx, mod);
                    lastEnd = col + len;
                }
            }
        }

        return builder.build();
    }
}
