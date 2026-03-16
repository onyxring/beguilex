import * as vscode from 'vscode';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';
import { BeguileCompletionItemProvider } from './completions';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'beguile' },
            new BeguileSemanticTokensProvider(),
            tokenLegend
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: 'beguile' },
            new BeguileCompletionItemProvider(),
            '.'  // also trigger on dot for member completions
        )
    );
}

export function deactivate() {}
