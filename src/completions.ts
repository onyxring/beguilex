import * as vscode from 'vscode';
import { collectAllSymbols } from './semanticTokens';

// Reserved Beguile keywords that won't appear in the collected symbol lists
const KEYWORDS: readonly string[] = [
    // Primitive / built-in types
    'int', 'bool', 'char', 'string', 'var', 'void', 'array', 'func',
    // Declaration keywords
    'class', 'object', 'enum', 'bnum', 'verb',
    // Modifiers
    'extern', 'emitter', 'extend', 'replace', 'alias', 'const', 'readonly', 'static', 'explicit',
    // Control flow
    'if', 'else', 'for', 'in', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'to', 'try', 'catch', 'throw',
    // Literals
    'true', 'false',
    // Special
    'self',
    'replaced',
];

export class BeguileCompletionItemProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {

        // Suppress completions when cursor is inside a comment
        const lineText  = document.lineAt(position.line).text;
        const charPos   = position.character;
        // Line comment: // appears before the cursor on this line
        const slashSlash = lineText.indexOf('//');
        if (slashSlash !== -1 && charPos > slashSlash) return [];
        // Block comment: scan from document start to cursor; if the last /* comes after the last */,
        // the cursor is inside an open block comment
        const textToCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const lastOpen  = textToCursor.lastIndexOf('/*');
        const lastClose = textToCursor.lastIndexOf('*/');
        if (lastOpen !== -1 && lastOpen > lastClose) return [];

        const { allTypes, allMembers, allFunctions, membersByClass, enumValuesByEnum } = await collectAllSymbols(document);

        // Check if cursor is inside a #beguilerSettings { } block
        const bsBlockRe = /#beguilerSettings\s*\{/g;
        let bsBlockMatch: RegExpExecArray | null;
        while ((bsBlockMatch = bsBlockRe.exec(textToCursor)) !== null) {
            const afterOpen = textToCursor.slice(bsBlockMatch.index + bsBlockMatch[0].length);
            let depth = 1;
            for (const ch of afterOpen) {
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) break; }
            }
            if (depth > 0) {
                // Check if cursor is after "propName =" — offer enum values for the property type
                const afterEqMatch = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[a-zA-Z0-9_]*$/.exec(
                    lineText.substring(0, position.character)
                );
                if (afterEqMatch) {
                    const propName = afterEqMatch[1];
                    const schemaMembers = membersByClass.get('beguilerSettingsType') ?? [];
                    const schemaMember = schemaMembers.find(m => m.name.toLowerCase() === propName.toLowerCase());
                    if (schemaMember) {
                        if (schemaMember.returnType === 'bool') {
                            return [
                                new vscode.CompletionItem('true',  vscode.CompletionItemKind.Value),
                                new vscode.CompletionItem('false', vscode.CompletionItemKind.Value),
                            ];
                        }
                        const enumValues = enumValuesByEnum.get(schemaMember.returnType);
                        if (enumValues) {
                            return enumValues.map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
                        }
                    }
                }
                // If cursor is after a dot, check if receiver is an enum type
                const dotPos = position.character > 0 && lineText[position.character - 1] === '.';
                if (dotPos || context.triggerCharacter === '.') {
                    const textBeforeDot = lineText.substring(0, position.character - 1);
                    const receiverMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(textBeforeDot);
                    if (receiverMatch) {
                        const enumValues = enumValuesByEnum.get(receiverMatch[1]);
                        if (enumValues) {
                            return enumValues.map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
                        }
                    }
                }

                // Offer property names
                const schemaMembers2 = membersByClass.get('beguilerSettingsType') ?? [];
                return schemaMembers2.map(m => {
                    const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Property);
                    item.detail = `${m.returnType} ${m.name}`;
                    return item;
                });
            }
        }

        // Suppress space triggers outside #beguilerSettings blocks
        if (context.triggerCharacter === ' ') return [];

        const dotBefore = position.character > 0 && lineText[position.character - 1] === '.';
        const isDot     = context.triggerCharacter === '.' || dotBefore;

        if (isDot) {
            // Extract receiver name: word immediately before the dot
            const textBeforeDot = lineText.substring(0, position.character - (dotBefore ? 1 : 0));
            const receiverMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(textBeforeDot);
            const receiverName = receiverMatch ? receiverMatch[1] : '';

            // If the receiver is an enum type name, offer its values
            if (receiverName) {
                const enumValues = enumValuesByEnum.get(receiverName);
                if (enumValues) {
                    return enumValues.map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
                }
            }

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
                // If the resolved type is an enum, offer its values
                if (resolvedTypeName) {
                    const enumValues = enumValuesByEnum.get(resolvedTypeName);
                    if (enumValues) {
                        return enumValues.map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
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

        // On = trigger, try to resolve LHS variable type and offer type-appropriate values
        if (context.triggerCharacter === '=') {
            const lhsMatch = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*==?$/.exec(
                lineText.substring(0, position.character).trimEnd()
            );
            if (lhsMatch) {
                const varName = lhsMatch[1];
                const typeNames = new Set(allTypes.map(t => t.name));
                let lhsType: string | null = null;
                for (let lineIdx = position.line; lineIdx >= 0 && lhsType === null; lineIdx--) {
                    const lt = document.lineAt(lineIdx).text;
                    const typeVarRe = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                    const tv = typeVarRe.exec(lt);
                    if (tv && typeNames.has(tv[1])) lhsType = tv[1];
                }
                if (lhsType === 'bool') {
                    return [
                        new vscode.CompletionItem('true',  vscode.CompletionItemKind.Value),
                        new vscode.CompletionItem('false', vscode.CompletionItemKind.Value),
                        ...allFunctions.filter(f => f.returnType === 'bool').map(f => {
                            const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
                            item.insertText = new vscode.SnippetString(`${f.name}($0)`);
                            item.detail = `${f.returnType} ${f.name}(${f.params})`;
                            return item;
                        }),
                    ];
                }
                if (lhsType) {
                    const enumValues = enumValuesByEnum.get(lhsType);
                    if (enumValues) {
                        return enumValues.map(v => new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember));
                    }
                }
            }
            // Unknown LHS type — suppress noise, let manual trigger show general list
            return [];
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
