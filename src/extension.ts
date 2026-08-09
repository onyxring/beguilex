import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { BeguileDebugAdapterFactory, openI6SourceCommand, openBglSourceCommand, setBeguileOutputChannel, setActiveVarFilter } from './beguileDebugAdapter';
import { VariableFilterViewProvider } from './variableFilterView';
import { setDebugPanelOutputChannel } from './debugPanel';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';

const outputChannel = vscode.window.createOutputChannel('Beguile');
let lspClient: LanguageClient | undefined;

/** Build the beguiler binary path and CLI args string from extension settings. */
function beguilerCommand(isDebug: boolean = false): { bin: string; args: string } {
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

    const libraryPath: string = bCfg.get('libraryPath') || '';
    if (libraryPath) {
        // No shell quoting — child_process.spawn passes args verbatim, so wrapping
        // in literal "..." would propagate the quote characters into beguiler's argv
        // and corrupt every libPath-derived file lookup. (Beguiler also defensively
        // strips matching " or ' from -lib= values, but don't rely on that here.)
        parts.push(`-lib=${libraryPath}`);
    }

    const extraBeguiler: string = bCfg.get('extraArgs') || '';
    if (extraBeguiler) { parts.push(extraBeguiler); }

    // Inform 6 settings
    const informPath: string = i6Cfg.get('inform6Path') || '';
    if (informPath) { parts.push(`-inform=${informPath}`); }

    const extraInform: string = i6Cfg.get('inform6ExtraArgs') || '';
    if (extraInform) { parts.push(extraInform); }

    if (isDebug && i6Cfg.get<boolean>('passDebugFlag', true)) {
        parts.push('-D');
    }

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
    outputChannel.appendLine('[Beguilex] Extension activated');
    setBeguileOutputChannel(outputChannel);
    setDebugPanelOutputChannel(outputChannel);

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('beguile', new BeguileDebugAdapterFactory(context))
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { scheme: 'file', language: 'beguile' },
            new BeguileSemanticTokensProvider(),
            tokenLegend
        )
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

    // ── Status bar: precompiler-mode indicator ───────────────────────────────
    // Lights up when the active editor is a .inf file containing one or more
    // Beguile islands (#bgl, #bglDecl, #bglStmt). Helps discoverability for
    // users opening unfamiliar precompiler-mode files.
    const bglInfStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    bglInfStatusItem.text = '$(beaker) Beguile precompiler mode';
    bglInfStatusItem.tooltip = 'This .inf file contains Beguile islands (#bgl, #bglDecl, or #bglStmt) — Beguile completion/hover/definition work inside them.';
    context.subscriptions.push(bglInfStatusItem);

    const updateBglInfStatus = (editor: vscode.TextEditor | undefined) => {
        if (!editor || editor.document.languageId !== 'inform6') {
            bglInfStatusItem.hide();
            return;
        }
        // Cheap content scan — same shape as the LSP server's findBglRegions.
        // We only need a yes/no, so we can stop at the first match.
        // Matches #bgl, #bglDecl, or #bglStmt followed by '{' or a single-line statement form.
        const text = editor.document.getText();
        if (/(^|[^a-zA-Z0-9_])#bgl(?:Decl|Stmt)?(\s*\{|\s+[^\n])/m.test(text)) {
            bglInfStatusItem.show();
        } else {
            bglInfStatusItem.hide();
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateBglInfStatus)
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (vscode.window.activeTextEditor?.document === e.document) {
                updateBglInfStatus(vscode.window.activeTextEditor);
            }
        })
    );
    updateBglInfStatus(vscode.window.activeTextEditor);

    // Re-open include completion after a backspace inside an #include / #includeI6 directive.
    // The LSP filters include candidates server-side (substring match) and returns isIncomplete,
    // so VS Code re-queries as you type FORWARD — but on deletion it doesn't re-request, and once
    // an over-typed path filters the list to empty (e.g. "gramt") the suggest widget closes, so
    // backspacing back to a matching prefix ("gra") never reopens it. Detect a pure deletion whose
    // cursor now sits inside an unclosed include delimiter and re-trigger suggestions.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || e.document !== editor.document) { return; }
            const lang = e.document.languageId;
            if (lang !== 'beguile' && lang !== 'inform6') { return; }
            // Only react to a pure deletion: nothing inserted, a non-empty range removed.
            const isDeletion = e.contentChanges.some(c => c.text.length === 0 && !c.range.isEmpty);
            if (!isDeletion) { return; }
            // Defer to a microtask: `editor.selection.active` isn't updated to the post-edit
            // cursor yet inside onDidChangeTextDocument (selection changes fire separately), and
            // VS Code needs a tick to finish processing the deletion — including its auto-closed
            // quote bookkeeping, which is why the sync version missed the closing-quote case.
            setTimeout(() => {
                const ed = vscode.window.activeTextEditor;
                if (!ed || ed.document !== e.document) { return; }
                const pos = ed.selection.active;
                const linePrefix = ed.document.lineAt(pos.line).text.substring(0, pos.character);
                // Cursor inside an unclosed include/path delimiter — either:
                //   `#include`/`#includeI6` <…> or "…"  (file/library completion), or
                //   `includePaths = "…"` inside #beguilerSettings  (directory completion).
                // Tolerates the optional `?`/`@` markers. `[^"<>]*$` = no closing delimiter before
                // the cursor (a closing quote AFTER the cursor is fine — linePrefix stops there).
                if (/(#include(i6)?\s*\??\s*@?\s*["<]|includepaths\s*=\s*")[^"<>]*$/i.test(linePrefix)) {
                    void vscode.commands.executeCommand('editor.action.triggerSuggest');
                }
            }, 0);
        })
    );

    // ── Beguile: Play ─────────────────────────────────────────────────────────
    const playCommand = vscode.commands.registerCommand('beguile.play', async () => {
        const editor = vscode.window.activeTextEditor;
        const langId = editor?.document.languageId;
        if (!editor || (langId !== 'beguile' && langId !== 'inform6')) {
            vscode.window.showErrorMessage('Open a .bgl or .inf file to play.');
            return;
        }
        const bglPath = editor.document.uri.fsPath;
        const { bin, args } = beguilerCommand();

        // Compile the file with beguiler (no --debug for plain play).
        // Use spawn (not exec) so stdout/stderr chunks interleave in the output channel
        // in their real chronological order instead of being split into two post-facto blobs.
        outputChannel.clear();
        outputChannel.show(true);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                const cmd = `"${bin}" ${args} "${bglPath}"`;
                outputChannel.appendLine(`> ${cmd}`);
                const child = cp.spawn(cmd, { shell: true });
                child.stdout.on('data', (chunk: Buffer) => outputChannel.append(chunk.toString()));
                child.stderr.on('data', (chunk: Buffer) => outputChannel.append(chunk.toString()));
                child.on('close', (code) => {
                    if (code !== 0) {
                        vscode.window.showErrorMessage('beguiler failed — see Beguile output panel for details.');
                        reject(new Error(`beguiler exited with code ${code}`));
                    } else {
                        resolve();
                    }
                });
                child.on('error', (err) => {
                    vscode.window.showErrorMessage('beguiler failed to start — see Beguile output panel for details.');
                    reject(err);
                });
            })
        ).then(undefined, () => { /* error already shown */ return; });

        // Locate the story file (beguiler writes it into output/ by default, or alongside source)
        // We re-derive the same path logic: check <bglDir>/output/<stem>.ulx, .z5 etc.
        const bglDir = path.dirname(bglPath);
        const stem = path.basename(bglPath, path.extname(bglPath));
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
        const langId = editor?.document.languageId;
        if (!editor || (langId !== 'beguile' && langId !== 'inform6')) {
            vscode.window.showErrorMessage('Open a .bgl or .inf file to debug.');
            return;
        }
        const bglPath = editor.document.uri.fsPath;
        const { bin, args } = beguilerCommand(true);

        // Compile with --debug. Same spawn-based streaming as the play path so output
        // stays chronologically ordered.
        outputChannel.clear();
        outputChannel.show(true);
        let compiledOk = true;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Compiling (debug) ${path.basename(bglPath)}…`, cancellable: false },
            () => new Promise<void>((resolve, reject) => {
                const cwd = path.dirname(bglPath);
                const cmd = `"${bin}" --debug ${args} "${bglPath}"`;
                outputChannel.appendLine(`> (cwd: ${cwd}) ${cmd}`);
                const child = cp.spawn(cmd, { cwd, shell: true });
                child.stdout.on('data', (chunk: Buffer) => outputChannel.append(chunk.toString()));
                child.stderr.on('data', (chunk: Buffer) => outputChannel.append(chunk.toString()));
                child.on('close', (code) => {
                    if (code !== 0) {
                        vscode.window.showErrorMessage('beguiler failed — see Beguile output panel for details.');
                        compiledOk = false;
                        reject(new Error(`beguiler exited with code ${code}`));
                    } else {
                        resolve();
                    }
                });
                child.on('error', (err) => {
                    vscode.window.showErrorMessage('beguiler failed to start — see Beguile output panel for details.');
                    compiledOk = false;
                    reject(err);
                });
            })
        ).then(undefined, () => { compiledOk = false; });
        if (!compiledOk) return;

        // Locate story file
        const bglDir = path.dirname(bglPath);
        const stem   = path.basename(bglPath, path.extname(bglPath));
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

        // Locate debug files. beguiler emits the debug bundle alongside its other
        // output: newer builds write it to the output folder (next to the story
        // file), older builds wrote it next to the source. Search both locations
        // (newest wins), then derive the transpiled .inf + .dbg from wherever the
        // .bgldbg was found, so all three always come from the same build.
        const bglBase  = path.basename(bglPath);          // e.g. "_unwelcomed.bgl"
        const storyDir = path.dirname(storyPath);         // the actual output folder
        const bgldbgPath = newestExisting([
            path.join(storyDir, bglBase + '.bgldbg'),
            path.join(bglDir,   bglBase + '.bgldbg'),
        ]);
        if (!bgldbgPath) {
            vscode.window.showErrorMessage('Debug file (.bgldbg) not found — ensure beguiler compiled with --debug.');
            return;
        }
        const dbgDir  = path.dirname(bgldbgPath);
        const infBase = path.join(dbgDir, bglBase + '.transpiled.inf');
        const dbgPath = infBase + '.dbg';
        if (!fs.existsSync(dbgPath)) {
            vscode.window.showErrorMessage('I6 debug file (.dbg) not found — ensure beguiler compiled with --debug.');
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

    // ── Language Server ─────────────────────────────────────────────────────
    // Pass all the same settings args to the LSP server as we do for compile/debug.
    const { bin: lspBin, args: lspArgs } = beguilerCommand();
    const serverOptions: ServerOptions = {
        command: lspBin,
        args: ['--lsp', ...lspArgs.split(' ').filter(a => a)],
    };
    const traceChannel = vscode.window.createOutputChannel('Beguile LSP Trace');
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'beguile' },
            { scheme: 'file', language: 'inform6' },
        ],
        outputChannel,
        traceOutputChannel: traceChannel,
    };
    lspClient = new LanguageClient('beguile', 'Beguile Language Server', serverOptions, clientOptions);

    const inactiveDecoration = vscode.window.createTextEditorDecorationType({
        opacity: '0.3',
        isWholeLine: true,
    });
    context.subscriptions.push(inactiveDecoration);

    const inactiveRangesByUri = new Map<string, vscode.Range[]>();

    const applyInactiveDecorations = (editor: vscode.TextEditor) => {
        const ranges = inactiveRangesByUri.get(editor.document.uri.toString()) ?? [];
        editor.setDecorations(inactiveDecoration, ranges);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const e of editors) if (e.document.languageId === 'beguile') applyInactiveDecorations(e);
        })
    );

    lspClient.start().then(() => {
        outputChannel.appendLine('[Beguilex] LSP client connected');
        lspClient!.onNotification('beguile/inactiveRegions', (params: { uri: string; ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[] }) => {
            // LSP ranges are end-exclusive. For whole-line decorations, an end
            // at {line:N, char:0} represents "up to but not including line N"
            // — but VS Code's decoration engine treats such a range as
            // intersecting line N and dims it anyway. Clamp the end to the
            // real end of the previous line so the trailing #else/#endif
            // construct stays at full opacity.
            const ranges = params.ranges.map(r => {
                let endLine = r.end.line;
                let endChar = r.end.character;
                if (endChar === 0 && endLine > r.start.line) {
                    endLine = endLine - 1;
                    endChar = Number.MAX_SAFE_INTEGER;
                }
                return new vscode.Range(
                    new vscode.Position(r.start.line, r.start.character),
                    new vscode.Position(endLine, endChar)
                );
            });
            inactiveRangesByUri.set(params.uri, ranges);
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.toString() === params.uri) {
                    applyInactiveDecorations(editor);
                }
            }
        });
    }, (err) => {
        outputChannel.appendLine('[Beguilex] LSP client FAILED: ' + err);
    });

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            inactiveRangesByUri.delete(doc.uri.toString());
        })
    );
    context.subscriptions.push(lspClient);
    outputChannel.appendLine('[Beguilex] LSP client starting: ' + lspBin + ' --lsp ' + lspArgs);
}

export async function deactivate() {
    if (lspClient) { await lspClient.stop(); }
}
