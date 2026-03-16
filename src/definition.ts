import * as vscode from 'vscode';
import { collectAllSymbols } from './semanticTokens';

export class BeguileDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Location | null> {

        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) return null;
        const word = document.getText(wordRange);

        const symbols = await collectAllSymbols(document);

        const lineText  = document.lineAt(position.line).text;
        const dotBefore = wordRange.start.character > 0 &&
                          lineText[wordRange.start.character - 1] === '.';

        let declFile: string | undefined;
        let declLine: number | undefined;
        let declCol:  number | undefined;

        if (dotBefore) {
            const m = symbols.allMembers.find(m => m.name === word);
            if (m) { declFile = m.declFile; declLine = m.declLine; declCol = m.declCol; }
        } else {
            const t = symbols.allTypes.find(t => t.name === word);
            if (t) {
                declFile = t.declFile; declLine = t.declLine; declCol = t.declCol;
            } else {
                const f = symbols.allFunctions.find(f => f.name === word);
                if (f) { declFile = f.declFile; declLine = f.declLine; declCol = f.declCol; }
            }
        }

        if (!declFile || declLine === undefined || declCol === undefined) return null;

        const uri = vscode.Uri.file(declFile);
        const pos = new vscode.Position(declLine, declCol);
        return new vscode.Location(uri, pos);
    }
}
