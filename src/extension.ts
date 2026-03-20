import * as vscode from 'vscode';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';
import { BeguileCompletionItemProvider } from './completions';
import { BeguileHoverProvider } from './hover';
import { BeguileSignatureHelpProvider } from './signatureHelp';
import { BeguileDefinitionProvider } from './definition';

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
            '.', '='  // trigger on dot and assignment
        ),
        vscode.languages.registerHoverProvider(
            { language: 'beguile' },
            new BeguileHoverProvider()
        ),
        vscode.languages.registerSignatureHelpProvider(
            { language: 'beguile' },
            new BeguileSignatureHelpProvider(),
            '(', ','
        ),
        vscode.languages.registerDefinitionProvider(
            { language: 'beguile' },
            new BeguileDefinitionProvider()
        )
    );
}

export function deactivate() {}
