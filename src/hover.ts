import * as vscode from 'vscode';
import { collectAllSymbols } from './semanticTokens';

export class BeguileHoverProvider implements vscode.HoverProvider {
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Hover | null> {

        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) return null;

        const word = document.getText(wordRange);
        const { allTypes, allMembers, allFunctions } = await collectAllSymbols(document);

        // Check if the character immediately before the word start is '.'
        const isDotAccess = wordRange.start.character > 0 &&
            document.lineAt(position.line).text[wordRange.start.character - 1] === '.';

        if (isDotAccess) {
            // Look up in allMembers
            const member = allMembers.find(m => m.name === word);
            if (member) {
                let label: string;
                if (member.tokenType === 'method') {
                    label = `(method) ${member.returnType} ${member.name}(${member.params})`;
                } else {
                    label = `(property) ${member.returnType} ${member.name}`;
                }
                const md = new vscode.MarkdownString();
                md.appendCodeblock(label, 'beguile');
                return new vscode.Hover(md, wordRange);
            }
            return null;
        }

        // Check allTypes
        const typeInfo = allTypes.find(t => t.name === word);
        if (typeInfo) {
            const keyword = typeInfo.tokenType === 'enum' ? 'enum' : 'class';
            const md = new vscode.MarkdownString();
            md.appendCodeblock(`${keyword} ${word}`, 'beguile');
            return new vscode.Hover(md, wordRange);
        }

        // Check allFunctions
        const funcInfo = allFunctions.find(f => f.name === word);
        if (funcInfo) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(`${funcInfo.returnType} ${funcInfo.name}(${funcInfo.params})`, 'beguile');
            return new vscode.Hover(md, wordRange);
        }

        return null;
    }
}
