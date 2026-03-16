import * as vscode from 'vscode';
import { collectAllSymbols } from './semanticTokens';

// Reserved Beguile keywords that won't appear in the collected symbol lists
const KEYWORDS: readonly string[] = [
    // Primitive / built-in types
    'int', 'bool', 'char', 'string', 'var', 'void', 'array', 'func',
    // Declaration keywords
    'class', 'object', 'enum', 'bnum', 'verb',
    // Modifiers
    'extern', 'emitter', 'extend', 'replace', 'alias', 'const',
    // Control flow
    'if', 'else', 'for', 'in', 'while', 'return', 'break', 'continue',
    // Literals
    'true', 'false',
    // Special
    'self',
];

export class BeguileCompletionItemProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {

        const { allTypes, allMembers, allFunctions, membersByClass } = await collectAllSymbols(document);

        // Detect dot context: explicit trigger or the character just before cursor is '.'
        const lineText  = document.lineAt(position.line).text;
        const dotBefore = position.character > 0 && lineText[position.character - 1] === '.';
        const isDot     = context.triggerCharacter === '.' || dotBefore;

        if (isDot) {
            // Extract receiver name: word immediately before the dot
            const textBeforeDot = lineText.substring(0, position.character - (dotBefore ? 1 : 0));
            const receiverMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(textBeforeDot);
            const receiverName = receiverMatch ? receiverMatch[1] : '';

            // Try to resolve receiver type by scanning document lines backward
            let resolvedTypeName: string | null = null;
            if (receiverName) {
                const typeNames = new Set(allTypes.map(t => t.name));
                for (let lineIdx = position.line; lineIdx >= 0 && resolvedTypeName === null; lineIdx--) {
                    const lt = document.lineAt(lineIdx).text;
                    // Look for "KnownType receiverName" pattern
                    const typeVarRe = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\s+${receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                    const tv = typeVarRe.exec(lt);
                    if (tv && typeNames.has(tv[1])) {
                        resolvedTypeName = tv[1];
                    }
                }
            }

            // Use type-specific members if we resolved a type, otherwise fall back to all members
            const membersToOffer = resolvedTypeName !== null
                ? (membersByClass.get(resolvedTypeName) ?? allMembers)
                : allMembers;

            return membersToOffer.map(m => {
                const kind = m.tokenType === 'method'
                    ? vscode.CompletionItemKind.Method
                    : vscode.CompletionItemKind.Property;
                const item = new vscode.CompletionItem(m.name, kind);
                if (m.tokenType === 'method') {
                    item.insertText = new vscode.SnippetString(`${m.name}($0)`);
                    item.detail = `${m.returnType} ${m.name}(${m.params})`;
                } else {
                    item.detail = `${m.returnType} ${m.name}`;
                }
                return item;
            });
        }

        const items: vscode.CompletionItem[] = [];

        // Keywords
        for (const kw of KEYWORDS) {
            items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
        }

        // Known types
        for (const t of allTypes) {
            const kind = t.tokenType === 'enum'
                ? vscode.CompletionItemKind.Enum
                : vscode.CompletionItemKind.Class;
            items.push(new vscode.CompletionItem(t.name, kind));
        }

        // Global functions — insert with parens and cursor between them
        for (const f of allFunctions) {
            const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
            item.insertText = new vscode.SnippetString(`${f.name}($0)`);
            item.detail = `${f.returnType} ${f.name}(${f.params})`;
            items.push(item);
        }

        return items;
    }
}
