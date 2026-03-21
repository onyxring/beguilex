import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';
import { BeguileCompletionItemProvider } from './completions';
import { BeguileHoverProvider } from './hover';
import { BeguileSignatureHelpProvider } from './signatureHelp';
import { BeguileDefinitionProvider } from './definition';
import { BeguileDebugAdapterFactory, openI6SourceCommand, openBglSourceCommand } from './beguileDebugAdapter';

const outputChannel = vscode.window.createOutputChannel('Beguile');

export function activate(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('beguile', new BeguileDebugAdapterFactory(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.openI6Source', openI6SourceCommand)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.openBglSource', openBglSourceCommand)
    );

    // ── Beguile: Play ─────────────────────────────────────────────────────────
    const playCommand = vscode.commands.registerCommand('beguile.play', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'beguile') {
            vscode.window.showErrorMessage('Open a .bgl file to play.');
            return;
        }
        const bglPath = editor.document.uri.fsPath;
        const config = vscode.workspace.getConfiguration('beguile');
        const beguilerBin: string = config.get('beguilerPath') || 'beguiler';
        const extraArgs: string   = config.get('extraBeguilerArgs') || '';

        // Compile the file with beguiler (no --debug for plain play)
        outputChannel.clear();
        outputChannel.show(true);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                cp.exec(`"${beguilerBin}" ${extraArgs} "${bglPath}"`, (err, stdout, stderr) => {
                    outputChannel.append(stdout);
                    if (stderr) outputChannel.append(stderr);
                    if (err) {
                        vscode.window.showErrorMessage('beguiler failed — see Beguile output panel for details.');
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            })
        ).then(undefined, () => { /* error already shown */ return; });

        // Locate the story file (beguiler writes it into output/ by default, or alongside source)
        // We re-derive the same path logic: check <bglDir>/output/<stem>.ulx, .z5 etc.
        const bglDir = path.dirname(bglPath);
        const stem = path.basename(bglPath, '.bgl');
        const candidates = [
            path.join(bglDir, 'output', stem + '.ulx'),
            path.join(bglDir, 'output', stem + '.z5'),
            path.join(bglDir, 'output', stem + '.z8'),
            path.join(bglDir, 'output', stem + '.z3'),
            path.join(bglDir, stem + '.ulx'),
            path.join(bglDir, stem + '.z5'),
        ];

        const { existsSync } = await import('fs');
        const storyPath = candidates.find(p => existsSync(p));
        if (!storyPath) {
            vscode.window.showErrorMessage('Could not locate compiled story file. Check beguiler output.');
            return;
        }

        const { GamePanel } = await import('./gamePanel');
        GamePanel.create(context, storyPath);
    });

    context.subscriptions.push(playCommand);

    // ── Beguile: Debug ────────────────────────────────────────────────────────
    const debugCommand = vscode.commands.registerCommand('beguile.debug', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'beguile') {
            vscode.window.showErrorMessage('Open a .bgl file to debug.');
            return;
        }
        const bglPath = editor.document.uri.fsPath;
        const config = vscode.workspace.getConfiguration('beguile');
        const beguilerBin: string = config.get('beguilerPath') || 'beguiler';
        const extraArgs: string   = config.get('extraBeguilerArgs') || '';

        // Compile with --debug
        outputChannel.clear();
        outputChannel.show(true);
        let compiledOk = true;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling (debug) ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                cp.exec(`"${beguilerBin}" --debug ${extraArgs} "${bglPath}"`, { cwd: path.dirname(bglPath) }, (err, stdout, stderr) => {
                    outputChannel.append(stdout);
                    if (stderr) outputChannel.append(stderr);
                    if (err) {
                        vscode.window.showErrorMessage('beguiler failed — see Beguile output panel for details.');
                        compiledOk = false;
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            })
        ).then(undefined, () => { compiledOk = false; });
        if (!compiledOk) return;

        // Locate story file
        const bglDir = path.dirname(bglPath);
        const stem   = path.basename(bglPath, '.bgl');
        const candidates = [
            path.join(bglDir, 'output', stem + '.ulx'),
            path.join(bglDir, 'output', stem + '.z5'),
            path.join(bglDir, 'output', stem + '.z8'),
            path.join(bglDir, 'output', stem + '.z3'),
            path.join(bglDir, stem + '.ulx'),
            path.join(bglDir, stem + '.z5'),
        ];
        const { existsSync } = await import('fs');
        const storyPath = candidates.find(p => existsSync(p));
        if (!storyPath) {
            vscode.window.showErrorMessage('Could not locate compiled story file.');
            return;
        }

        // Locate debug files (beguiler --debug writes these alongside the .inf)
        const infBase    = bglPath + '.transpiled.inf';
        const bgldbgPath = infBase + '.bgldbg';
        const dbgPath    = infBase + '.dbg';
        if (!existsSync(bgldbgPath) || !existsSync(dbgPath)) {
            vscode.window.showErrorMessage('Debug files (.bgldbg / .dbg) not found — ensure beguiler compiled with --debug.');
            return;
        }

        const ext = path.extname(storyPath).toLowerCase();
        const isZMachine = ['.z3', '.z5', '.z6', '.z8', '.zblorb'].includes(ext);
        await vscode.debug.startDebugging(
            vscode.workspace.workspaceFolders?.[0],
            {
                type: 'beguile',
                name: `Debug: ${path.basename(bglPath)}`,
                request: 'launch',
                storyPath,
                bgldbgPath,
                dbgPath,
                isZMachine,
            }
        );
    });

    context.subscriptions.push(debugCommand);

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
