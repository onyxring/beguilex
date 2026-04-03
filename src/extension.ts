import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';
import { BeguileCompletionItemProvider } from './completions';
import { BeguileHoverProvider } from './hover';
import { BeguileSignatureHelpProvider } from './signatureHelp';
import { BeguileDefinitionProvider } from './definition';
import { BeguileDebugAdapterFactory, openI6SourceCommand, openBglSourceCommand, setBeguileOutputChannel, setActiveVarFilter } from './beguileDebugAdapter';
import { VariableFilterViewProvider } from './variableFilterView';
import { setDebugPanelOutputChannel } from './debugPanel';

const outputChannel = vscode.window.createOutputChannel('Beguile');

/** Build the beguiler binary path and CLI args string from extension settings. */
function beguilerCommand(): { bin: string; args: string } {
    const bCfg  = vscode.workspace.getConfiguration('beguiler');
    const i6Cfg = vscode.workspace.getConfiguration('i6');
    const bin: string = bCfg.get('path') || 'beguiler';
    const parts: string[] = [];

    // Beguiler settings
    const target: string = bCfg.get('target') || '';
    if (target) {
        const flag = target === 'Glulx' ? '-G' : `-${target.toLowerCase()}`;
        parts.push(flag);
    }

    const errorFormat: string = bCfg.get('errorFormat') || '';
    if (errorFormat) { parts.push(`-${errorFormat}`); }

    const outputPath: string = bCfg.get('outputPath') || '';
    if (outputPath) { parts.push(`-o "${outputPath}"`); }

    const includePaths: string = bCfg.get('includePaths') || '';
    if (includePaths) {
        for (const p of includePaths.split(',')) {
            const trimmed = p.trim();
            if (trimmed) { parts.push(`-includepaths=${trimmed}`); }
        }
    }

    const extraBeguiler: string = bCfg.get('extraArgs') || '';
    if (extraBeguiler) { parts.push(extraBeguiler); }

    // Inform 6 settings
    const informPath: string = i6Cfg.get('inform6Path') || '';
    if (informPath) { parts.push(`-inform=${informPath}`); }

    const extraInform: string = i6Cfg.get('inform6ExtraArgs') || '';
    if (extraInform) { parts.push(extraInform); }

    return { bin, args: parts.join(' ') };
}

/** Return the most-recently-modified file among the candidates that exist. */
function newestExisting(candidates: string[]): string | undefined {
    let best: string | undefined;
    let bestMtime = -1;
    for (const p of candidates) {
        try {
            const mtime = fs.statSync(p).mtimeMs;
            if (mtime > bestMtime) { bestMtime = mtime; best = p; }
        } catch { /* doesn't exist */ }
    }
    return best;
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('[Beguile] Extension activated (quixe-debug-v2)');
    setBeguileOutputChannel(outputChannel);
    setDebugPanelOutputChannel(outputChannel);

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('beguile', new BeguileDebugAdapterFactory(context))
    );

    const filterView = new VariableFilterViewProvider(context, (filter) => setActiveVarFilter(filter));
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VariableFilterViewProvider.viewType, filterView)
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
        const { bin, args } = beguilerCommand();

        // Compile the file with beguiler (no --debug for plain play)
        outputChannel.clear();
        outputChannel.show(true);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                cp.exec(`"${bin}" ${args} "${bglPath}"`, (err, stdout, stderr) => {
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
            path.join(bglDir, 'output', stem + '.gblorb'),
            path.join(bglDir, 'output', stem + '.ulx'),
            path.join(bglDir, 'output', stem + '.zblorb'),
            path.join(bglDir, 'output', stem + '.z5'),
            path.join(bglDir, 'output', stem + '.z8'),
            path.join(bglDir, 'output', stem + '.z3'),
            path.join(bglDir, stem + '.ulx'),
            path.join(bglDir, stem + '.z5'),
        ];

        const storyPath = newestExisting(candidates);
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
        const { bin, args } = beguilerCommand();

        // Compile with --debug
        outputChannel.clear();
        outputChannel.show(true);
        let compiledOk = true;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling (debug) ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                cp.exec(`"${bin}" --debug ${args} "${bglPath}"`, { cwd: path.dirname(bglPath) }, (err, stdout, stderr) => {
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
            path.join(bglDir, 'output', stem + '.gblorb'),
            path.join(bglDir, 'output', stem + '.ulx'),
            path.join(bglDir, 'output', stem + '.zblorb'),
            path.join(bglDir, 'output', stem + '.z5'),
            path.join(bglDir, 'output', stem + '.z8'),
            path.join(bglDir, 'output', stem + '.z3'),
            path.join(bglDir, stem + '.ulx'),
            path.join(bglDir, stem + '.z5'),
        ];
        const storyPath = newestExisting(candidates);
        if (!storyPath) {
            vscode.window.showErrorMessage('Could not locate compiled story file.');
            return;
        }

        // Locate debug files
        const infBase    = bglPath + '.transpiled.inf';
        const bgldbgPath = bglPath + '.bgldbg';
        const dbgPath    = infBase + '.dbg';
        if (!fs.existsSync(bgldbgPath) || !fs.existsSync(dbgPath)) {
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
                infPath: infBase,
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
