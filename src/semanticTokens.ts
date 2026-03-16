import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Token types and modifiers exposed to VSCode
const tokenTypes = ['class', 'enum', 'property', 'method'];
const tokenModifiers = ['declaration'];
export const tokenLegend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// Type declaration: (optional modifiers) (keyword) (name)
const DECL_RE = /^\s*(?:extern\s+|emitter\s+|alias\s+)*\b(class|object|enum|bnum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Member declaration inside a class/object body:
// optional modifiers, return type, member name, then '(' (method) or ';' (property)
const MEMBER_DECL_RE = /^\s*(?:(?:extern|emitter|replace|const|array)\s+)*\b([a-zA-Z_][a-zA-Z0-9_<>]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(\(|;)/;

// #include <name> or #include "path"  (not #includeI6 — those are raw I6 files)
const INCLUDE_RE = /^\s*#include\s*(?:<([^>]+)>|"([^"]+)")/;

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
            const start = i++;
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\') i++;
                i++;
            }
            ranges.push([start, i]);
        }
        i++;
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
    tokenType: 'class' | 'enum';
    declLine: number;
    declCol: number;
}

interface MemberInfo {
    name: string;
    tokenType: 'method' | 'property';
    declLine: number;
    declCol: number;
}

// ── Declaration collectors ─────────────────────────────────────────────────

function collectDeclarations(lines: string[], seen: Set<string>): TypeInfo[] {
    const types: TypeInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripComments(lines[i]);
        const m = DECL_RE.exec(stripped);
        if (!m) continue;
        const keyword = m[1];
        const name = m[2];
        if (seen.has(name)) continue;
        seen.add(name);
        const tokenType: 'class' | 'enum' =
            (keyword === 'enum' || keyword === 'bnum') ? 'enum' : 'class';
        const col = lines[i].indexOf(
            name,
            lines[i].search(/\b(?:class|object|enum|bnum)\b/) + keyword.length
        );
        types.push({ name, tokenType, declLine: i, declCol: col });
    }
    return types;
}

function collectMembers(lines: string[], seen: Set<string>): MemberInfo[] {
    const members: MemberInfo[] = [];
    let depth = 0;
    let classBodyDepth = -1;
    let i6Depth = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComments(raw);

        const i6Open = /^\s*#i6(?:raw)?\s*\{/.test(stripped);
        if (i6Open && i6Depth === -1) i6Depth = depth;

        const delta = netBraceChange(stripped);
        const declMatch = DECL_RE.exec(stripped);

        if (declMatch && delta > 0 && i6Depth === -1) {
            const kw = declMatch[1];
            if (kw === 'class' || kw === 'object') {
                classBodyDepth = depth + delta;
            }
        }

        if (i6Depth !== -1) {
            depth += delta;
            if (depth <= i6Depth) i6Depth = -1;
        } else {
            depth += delta;
        }

        if (classBodyDepth !== -1 && depth < classBodyDepth) classBodyDepth = -1;

        if (classBodyDepth !== -1 && depth === classBodyDepth && i6Depth === -1 && !declMatch) {
            const mm = MEMBER_DECL_RE.exec(stripped);
            if (mm) {
                const name = mm[2];
                const isMethod = mm[3] === '(';
                if (!seen.has(name)) {
                    seen.add(name);
                    const typeStr = mm[1];
                    const typeIdx = raw.search(new RegExp('\\b' + reEsc(typeStr) + '\\b'));
                    const col = typeIdx >= 0 ? raw.indexOf(name, typeIdx + typeStr.length) : raw.indexOf(name);
                    members.push({ name, tokenType: isMethod ? 'method' : 'property', declLine: i, declCol: col >= 0 ? col : 0 });
                }
            }
        }
    }
    return members;
}

// ── Include resolution ─────────────────────────────────────────────────────

// Locate a system include (<name>) by searching the workspace for name.bgl
// inside any beguiLib directory (or any .bgl matching the name).
async function findSystemInclude(name: string): Promise<string | null> {
    const withExt = name.endsWith('.bgl') ? name : `${name}.bgl`;
    // Prefer files inside a beguiLib folder; fall back to any workspace match
    const inLib = await vscode.workspace.findFiles(`**/beguiLib/**/${withExt}`, undefined, 1);
    if (inLib.length > 0) return inLib[0].fsPath;
    const anywhere = await vscode.workspace.findFiles(`**/${withExt}`, '**/node_modules/**', 1);
    if (anywhere.length > 0) return anywhere[0].fsPath;
    return null;
}

// Locate _beguileCore.bgl using the configured libraryPath setting first,
// then falling back to a workspace search. This mirrors the compiler's own
// library resolution: in dev mode the lib sits next to the source tree; in
// release mode it sits next to the beguiler executable. The setting lets the
// user point at either location explicitly.
async function findCoreLibrary(): Promise<string | null> {
    const config  = vscode.workspace.getConfiguration('beguile');
    const libPath = config.get<string>('libraryPath');

    if (libPath) {
        const base      = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const resolved  = path.isAbsolute(libPath) ? libPath : path.join(base, libPath);
        const candidate = path.join(resolved, '_beguileCore.bgl');
        if (fs.existsSync(candidate)) return candidate;
    }

    // Auto-detect: search workspace for _beguileCore.bgl
    return findSystemInclude('_beguileCore');
}

// Recursively walk #include directives, collecting declarations and members
// from each referenced file. `visited` prevents cycles.
async function collectFromIncludes(
    lines: string[],
    currentFilePath: string,
    visited: Set<string>,
    typeSeen: Set<string>,
    memberSeen: Set<string>,
    allTypes: TypeInfo[],
    allMembers: MemberInfo[]
): Promise<void> {
    for (const line of lines) {
        const m = INCLUDE_RE.exec(line);
        if (!m) continue;

        const isSystem = !!m[1];
        const name = m[1] ?? m[2];

        let resolved: string | null = null;
        if (isSystem) {
            resolved = await findSystemInclude(name);
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
        allTypes.push(...collectDeclarations(fileLines, typeSeen));
        allMembers.push(...collectMembers(fileLines, memberSeen));
        await collectFromIncludes(fileLines, resolved, visited, typeSeen, memberSeen, allTypes, allMembers);
    }
}

// ── Semantic tokens provider ───────────────────────────────────────────────

export class BeguileSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(tokenLegend);
        const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

        // Shared seen-sets ensure names declared in the current file take
        // precedence over identically-named declarations in included files.
        const typeSeen: Set<string>   = new Set();
        const memberSeen: Set<string> = new Set();

        const allTypes:   TypeInfo[]   = collectDeclarations(lines, typeSeen);
        const allMembers: MemberInfo[] = collectMembers(lines, memberSeen);

        // Always scan _beguileCore.bgl first — it is implicitly available in
        // every Beguile file without an explicit #include.
        const visited = new Set<string>([document.uri.fsPath]);
        const coreFile = await findCoreLibrary();
        if (coreFile && !visited.has(coreFile)) {
            visited.add(coreFile);
            try {
                const coreLines = fs.readFileSync(coreFile, 'utf8').split('\n');
                allTypes.push(...collectDeclarations(coreLines, typeSeen));
                allMembers.push(...collectMembers(coreLines, memberSeen));
                await collectFromIncludes(coreLines, coreFile, visited, typeSeen, memberSeen, allTypes, allMembers);
            } catch { /* core not found, continue */ }
        }

        // Scan files referenced by explicit #include directives
        await collectFromIncludes(lines, document.uri.fsPath, visited, typeSeen, memberSeen, allTypes, allMembers);

        if (allTypes.length === 0 && allMembers.length === 0) return builder.build();

        // ── Build lookup maps ──────────────────────────────────────────────
        const typeMap   = new Map<string, TypeInfo>(allTypes.map(t => [t.name, t]));
        const memberMap = new Map<string, MemberInfo>(allMembers.map(m => [m.name, m]));

        const typePattern = allTypes.length > 0
            ? new RegExp(`\\b(${allTypes.map(t => reEsc(t.name)).join('|')})\\b`, 'g')
            : null;

        const memberPattern = allMembers.length > 0
            ? new RegExp(`\\.(${allMembers.map(m => reEsc(m.name)).join('|')})\\b`, 'g')
            : null;

        // ── Emit tokens line by line (current document only) ──────────────
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const raw = lines[lineIdx];
            if (/^\s*\/\//.test(raw)) continue;

            const stripped  = stripComments(raw);
            const strRanges = stringRanges(stripped);

            // Type name tokens
            if (typePattern) {
                typePattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = typePattern.exec(stripped)) !== null) {
                    const col = m.index;
                    if (inRange(col, strRanges)) continue;
                    const info = typeMap.get(m[1])!;
                    const isDecl = lineIdx === info.declLine && col === info.declCol;
                    builder.push(lineIdx, col, m[1].length,
                        tokenTypes.indexOf(info.tokenType),
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0);
                }
            }

            // Member tokens: '.memberName' after an alphanumeric or ')'
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
                    const isDecl = lineIdx === info.declLine && nameCol === info.declCol;
                    builder.push(lineIdx, nameCol, name.length,
                        tokenTypes.indexOf(info.tokenType),
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0);
                }
            }
        }

        return builder.build();
    }
}
