import * as vscode from 'vscode';

// Token types and modifiers exposed to VSCode
const tokenTypes = ['class', 'enum', 'property', 'method'];
const tokenModifiers = ['declaration'];
export const tokenLegend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// Type declaration: (optional modifiers) (keyword) (name)
const DECL_RE = /^\s*(?:extern\s+|emitter\s+|alias\s+)*\b(class|object|enum|bnum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Member declaration inside a class/object body:
// optional modifiers, return type, member name, then '(' (method) or ';' (property)
const MEMBER_DECL_RE = /^\s*(?:(?:extern|emitter|replace|const|array)\s+)*\b([a-zA-Z_][a-zA-Z0-9_<>]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(\(|;)/;

// ── Helpers ────────────────────────────────────────────────────────────────

// Strip line and block comments from a line (best-effort; doesn't handle
// multi-line block comments that span more than one line).
function stripComments(line: string): string {
    line = line.replace(/\/\*.*?\*\//g, match => ' '.repeat(match.length));
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.substring(0, lc);
    return line;
}

// Count net brace change on a line, ignoring braces inside string literals.
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

// Return column ranges of string literals on a line (for usage-scan skipping).
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

// Escape a string for use as a regex literal.
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

// ── Pass 1: collect type declarations ─────────────────────────────────────

function collectDeclarations(lines: string[]): TypeInfo[] {
    const types: TypeInfo[] = [];
    const seen = new Set<string>();

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

// ── Pass 2: collect member declarations ───────────────────────────────────
//
// We walk lines maintaining a brace depth.  When a class/object declaration
// is seen that opens a body on the same line, we note that classBodyDepth =
// depth after processing that line.  Lines where depth equals classBodyDepth
// are direct members of the class.  #i6{} blocks are detected so their
// internal braces don't confuse the depth counter.

function collectMembers(lines: string[]): MemberInfo[] {
    const members: MemberInfo[] = [];
    const seen = new Set<string>();

    let depth = 0;
    let classBodyDepth = -1;  // brace depth of the interior of the current class/object
    let i6Depth = -1;         // brace depth at which an #i6 block opened (-1 = not in one)

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComments(raw);

        // Detect #i6 / #i6raw block start — skip its braces from depth tracking
        const i6Open = /^\s*#i6(?:raw)?\s*\{/.test(stripped);
        if (i6Open && i6Depth === -1) {
            i6Depth = depth; // will be incremented below
        }

        const delta = netBraceChange(stripped);

        // Detect a class/object declaration that opens its body on this line
        const declMatch = DECL_RE.exec(stripped);
        const opensBody = delta > 0;

        if (declMatch && opensBody && i6Depth === -1) {
            const kw = declMatch[1];
            if (kw === 'class' || kw === 'object') {
                // Body depth is depth + delta (the interior after the '{')
                classBodyDepth = depth + delta;
            }
        }

        // Update depth — but don't let i6 contents change our logical depth
        if (i6Depth !== -1) {
            // We're inside an i6 block; track its close without affecting classBodyDepth logic
            depth += delta;
            if (depth <= i6Depth) {
                // The i6 block's closing } has been consumed
                i6Depth = -1;
            }
        } else {
            depth += delta;
        }

        // If we just stepped out of a class body, clear it
        if (classBodyDepth !== -1 && depth < classBodyDepth) {
            classBodyDepth = -1;
        }

        // Look for member declarations only at the class body's direct depth,
        // skipping the declaration line itself and i6 blocks.
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
                    members.push({
                        name,
                        tokenType: isMethod ? 'method' : 'property',
                        declLine: i,
                        declCol: col >= 0 ? col : 0
                    });
                }
            }
        }
    }

    return members;
}

// ── Semantic tokens provider ───────────────────────────────────────────────

export class BeguileSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const builder = new vscode.SemanticTokensBuilder(tokenLegend);
        const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

        const types   = collectDeclarations(lines);
        const members = collectMembers(lines);

        // ── Build lookup maps ──────────────────────────────────────────────

        const typeMap   = new Map<string, TypeInfo>(types.map(t => [t.name, t]));
        const memberMap = new Map<string, MemberInfo>(members.map(m => [m.name, m]));

        // Regex for type names appearing as bare words
        const typePattern = types.length > 0
            ? new RegExp(`\\b(${types.map(t => reEsc(t.name)).join('|')})\\b`, 'g')
            : null;

        // Regex for member names appearing after a '.'
        // We match '.name' and then verify the character before '.' is alphanumeric or ')'
        const memberPattern = members.length > 0
            ? new RegExp(`\\.(${members.map(m => reEsc(m.name)).join('|')})\\b`, 'g')
            : null;

        // ── Emit tokens line by line ───────────────────────────────────────

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
                    builder.push(
                        lineIdx, col, m[1].length,
                        tokenTypes.indexOf(info.tokenType),
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0
                    );
                }
            }

            // Member tokens: '.memberName' — verify preceding char is word char or ')'
            if (memberPattern) {
                memberPattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = memberPattern.exec(stripped)) !== null) {
                    const dotCol  = m.index;
                    const nameCol = dotCol + 1;
                    const name    = m[1];

                    // Must be a member access, not a dictionary word
                    const preceding = dotCol > 0 ? stripped[dotCol - 1] : '';
                    if (!/[a-zA-Z0-9_)]/.test(preceding)) continue;
                    if (inRange(nameCol, strRanges)) continue;

                    const info = memberMap.get(name)!;
                    const isDecl = lineIdx === info.declLine && nameCol === info.declCol;
                    builder.push(
                        lineIdx, nameCol, name.length,
                        tokenTypes.indexOf(info.tokenType),
                        isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0
                    );
                }
            }
        }

        return builder.build();
    }
}
