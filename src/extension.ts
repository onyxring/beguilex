import * as vscode from 'vscode';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'beguile' },
            new BeguileSemanticTokensProvider(),
            tokenLegend
        )
    );
}

export function deactivate() {}
