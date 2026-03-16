import * as vscode from 'vscode';
import { collectAllSymbols } from './semanticTokens';

export class BeguileSignatureHelpProvider implements vscode.SignatureHelpProvider {
    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | null> {

        const lineText = document.lineAt(position.line).text;
        const textUpToCursor = lineText.substring(0, position.character);

        // Walk backward to find the innermost unclosed '('
        let depth = 0;
        let openParenIdx = -1;
        for (let i = textUpToCursor.length - 1; i >= 0; i--) {
            const ch = textUpToCursor[i];
            if (ch === ')') {
                depth++;
            } else if (ch === '(') {
                if (depth === 0) {
                    openParenIdx = i;
                    break;
                }
                depth--;
            }
        }

        if (openParenIdx < 0) return null;

        // Extract function/method name immediately before '('
        const beforeParen = textUpToCursor.substring(0, openParenIdx);
        const nameMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(beforeParen);
        if (!nameMatch) return null;

        const funcName = nameMatch[1];
        const { allFunctions, allMembers } = await collectAllSymbols(document);

        // Look up in allFunctions first, then allMembers (methods only)
        let params = '';
        let returnType = '';
        let found = false;

        const funcInfo = allFunctions.find(f => f.name === funcName);
        if (funcInfo) {
            params = funcInfo.params;
            returnType = funcInfo.returnType;
            found = true;
        } else {
            const memberInfo = allMembers.find(m => m.name === funcName && m.tokenType === 'method');
            if (memberInfo) {
                params = memberInfo.params;
                returnType = memberInfo.returnType;
                found = true;
            }
        }

        if (!found) return null;

        // Build SignatureInformation
        const sigLabel = `${returnType} ${funcName}(${params})`;
        const sig = new vscode.SignatureInformation(sigLabel);

        // Split params into individual ParameterInformation
        if (params.trim().length > 0) {
            const paramList = params.split(',');
            let searchStart = sigLabel.indexOf('(') + 1;
            for (const p of paramList) {
                const trimmed = p.trim();
                const startIdx = sigLabel.indexOf(trimmed, searchStart);
                const endIdx = startIdx + trimmed.length;
                sig.parameters.push(new vscode.ParameterInformation([startIdx, endIdx]));
                searchStart = endIdx + 1; // skip past comma
            }
        }

        // Count commas at depth 0 in the args text to determine activeParameter
        const argsText = textUpToCursor.substring(openParenIdx + 1);
        let activeParameter = 0;
        let argDepth = 0;
        for (const ch of argsText) {
            if (ch === '(' || ch === '[') {
                argDepth++;
            } else if (ch === ')' || ch === ']') {
                argDepth--;
            } else if (ch === ',' && argDepth === 0) {
                activeParameter++;
            }
        }

        const help = new vscode.SignatureHelp();
        help.signatures = [sig];
        help.activeSignature = 0;
        help.activeParameter = activeParameter;

        return help;
    }
}
