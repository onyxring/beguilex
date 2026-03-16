import * as vscode from 'vscode';

// Token types and modifiers exposed to VSCode
const tokenTypes = ['class', 'enum'];
const tokenModifiers = ['declaration'];
export const tokenLegend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

// Patterns that declare a named type in Beguile
// Groups: (modifiers) (keyword) (name)
const DECL_RE = /^\s*(?:extern\s+|emitter\s+|alias\s+)*\b(class|object|enum|bnum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Strip line and block comments from a line for safe identifier scanning.
// This is best-effort: doesn't handle multi-line block comments.
function stripComments(line: string): string {
    // Remove block comment fragments on a single line: /* ... */
    line = line.replace(/\/\*.*?\*\//g, match => ' '.repeat(match.length));
    // Remove line comment
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.substring(0, lc);
    return line;
}

// Return the ranges of string and #i6 content on a line that should be skipped.
// We mark string ranges so we don't highlight identifiers inside them.
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

interface TypeInfo {
    name: string;
    tokenType: 'class' | 'enum';
    declLine: number;
    declCol: number;
}

function collectDeclarations(lines: string[]): TypeInfo[] {
    const types: TypeInfo[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const stripped = stripComments(lines[i]);
        const m = DECL_RE.exec(stripped);
        if (!m) continue;

        const keyword = m[1];   // class | object | enum | bnum
        const name = m[2];

        if (seen.has(name)) continue;
        seen.add(name);

        const tokenType: 'class' | 'enum' =
            (keyword === 'enum' || keyword === 'bnum') ? 'enum' : 'class';

        // Column of name in the original (un-stripped) line
        const col = lines[i].indexOf(name, lines[i].search(/\b(class|object|enum|bnum)\b/) + keyword.length);

        types.push({ name, tokenType, declLine: i, declCol: col });
    }

    return types;
}

export class BeguileSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const builder = new vscode.SemanticTokensBuilder(tokenLegend);
        const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

        const types = collectDeclarations(lines);
        if (types.length === 0) return builder.build();

        // Build a map from name -> TypeInfo for fast lookup
        const typeMap = new Map<string, TypeInfo>();
        for (const t of types) typeMap.set(t.name, t);

        // Build a regex that matches any declared type name as a whole word
        const namePattern = new RegExp(
            `\\b(${types.map(t => t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
            'g'
        );

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const raw = lines[lineIdx];
            // Skip pure comment lines quickly
            if (/^\s*\/\//.test(raw)) continue;

            const stripped = stripComments(raw);
            const strRanges = stringRanges(stripped);

            namePattern.lastIndex = 0;
            let m: RegExpExecArray | null;

            while ((m = namePattern.exec(stripped)) !== null) {
                const name = m[1];
                const col = m.index;

                // Skip if inside a string literal
                if (inRange(col, strRanges)) continue;

                const info = typeMap.get(name)!;
                const isDecl = lineIdx === info.declLine && col === info.declCol;

                builder.push(
                    lineIdx,
                    col,
                    name.length,
                    tokenTypes.indexOf(info.tokenType),
                    isDecl ? (1 << tokenModifiers.indexOf('declaration')) : 0
                );
            }
        }

        return builder.build();
    }
}
