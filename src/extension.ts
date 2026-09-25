import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, ServerOptions, State } from 'vscode-languageclient/node';
import { BeguileDebugAdapterFactory, openI6SourceCommand, openBglSourceCommand, setBeguileOutputChannel, setActiveVarFilter, parkInterpreterPanel } from './beguileDebugAdapter';
import { VariableFilterViewProvider } from './variableFilterView';
import { setDebugPanelOutputChannel } from './debugPanel';
import { BeguileSemanticTokensProvider, tokenLegend } from './semanticTokens';

const outputChannel = vscode.window.createOutputChannel('Beguile');
let lspClient: LanguageClient | undefined;

// fsPath of the designated entry-point .bgl (the file F5/Debug/Play compiles, and the root the
// LSP parses included files against so their #if gating/symbols resolve). undefined = none set;
// callers then fall back to the active editor. Persisted in workspaceState under this key.
let beguileEntryPoint: string | undefined;
/** Last source actually compiled by Play/Debug — lets F5 work from the interpreter panel,
 *  where there is no active text editor to fall back on. */
let lastLaunchedBglPath: string | undefined;
const LAST_LAUNCHED_STATE_KEY = 'beguile.lastLaunchedBglPath';
const ENTRY_POINT_STATE_KEY = 'beguile.entryPoint';

/** Push the current entry point to the language server (empty path clears it). No-op if the client isn't running. */
function sendEntryPointToLsp(): void {
    if (!lspClient || lspClient.state !== State.Running) { return; }
    lspClient.sendNotification('beguile/setEntryPoint', {
        uri: beguileEntryPoint ? vscode.Uri.file(beguileEntryPoint).toString() : '',
    });
}

/** Push editor settings the server honors (currently `syntaxHints`) to the language server. */
function sendConfigToLsp(): void {
    if (!lspClient || lspClient.state !== State.Running) { return; }
    const syntaxHints = vscode.workspace.getConfiguration('beguiler').get<boolean>('syntaxHints', true);
    lspClient.sendNotification('beguile/setConfig', { syntaxHints });
}

/** The file to compile/run: the entry point when set (and still present), else the active editor's file. */
function resolveRunTarget(editor: vscode.TextEditor | undefined): string | undefined {
    if (beguileEntryPoint && fs.existsSync(beguileEntryPoint)) { return beguileEntryPoint; }
    return editor?.document.uri.fsPath;
}

/**
 * The source Play/Debug should compile, in priority order: the designated entry point, the active
 * .bgl/.inf editor, then the last source we launched. The third case is what makes F5 work from the
 * interpreter panel — a focused webview means there is no active text editor at all.
 * Reports the failure itself and returns undefined when nothing resolves.
 */
function resolveLaunchSource(verb: 'play' | 'debug'): string | undefined {
    if (beguileEntryPoint && fs.existsSync(beguileEntryPoint)) { return beguileEntryPoint; }

    const editor = vscode.window.activeTextEditor;
    const langId = editor?.document.languageId;
    if (editor && (langId === 'beguile' || langId === 'inform6')) { return editor.document.uri.fsPath; }

    if (lastLaunchedBglPath && fs.existsSync(lastLaunchedBglPath)) { return lastLaunchedBglPath; }

    vscode.window.showErrorMessage(`Set a Beguile entry point, or open a .bgl/.inf file to ${verb}.`);
    return undefined;
}

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

// Live Beguile debug sessions (populated by onDidStart/Terminate listeners in
// activate). Used to tear down a running session before a new Run starts.
const activeBeguileSessions = new Set<vscode.DebugSession>();

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('[Beguilex] Extension activated');
    setBeguileOutputChannel(outputChannel);
    setDebugPanelOutputChannel(outputChannel);

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('beguile', new BeguileDebugAdapterFactory(context))
    );

    // Track live Beguile debug sessions so a fresh Run can stop the previous one
    // instead of stacking a second session on top of it.
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((s) => {
            if (s.type === 'beguile') { activeBeguileSessions.add(s); }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => {
            activeBeguileSessions.delete(s);
        })
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
        const bglPath = resolveLaunchSource('play');
        if (!bglPath) { return; }
        lastLaunchedBglPath = bglPath;
        context.workspaceState.update(LAST_LAUNCHED_STATE_KEY, bglPath);
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
        const bglPath = resolveLaunchSource('debug');
        if (!bglPath) { return; }
        lastLaunchedBglPath = bglPath;
        context.workspaceState.update(LAST_LAUNCHED_STATE_KEY, bglPath);
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

        // Tear down any Beguile debug session already running so a fresh Run
        // replaces it instead of stacking a second interpreter/session on top.
        if (activeBeguileSessions.size > 0) {
            // Hand the live interpreter panel to the session about to start, so the re-run
            // reuses it where it sits instead of closing it and reopening somewhere else.
            parkInterpreterPanel(context);
            const stopping = [...activeBeguileSessions];
            await Promise.all(stopping.map((s) => vscode.debug.stopDebugging(s)));
            // Wait (briefly) for termination events to drain the set so the new
            // session starts from a clean slate.
            const deadline = Date.now() + 3000;
            while (activeBeguileSessions.size > 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }

        const ext = path.extname(storyPath).toLowerCase();
        const isZMachine = ['.z3', '.z5', '.z6', '.z8', '.zblorb'].includes(ext);
        const started = await vscode.debug.startDebugging(
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

        // The compile log has served its purpose once the session is live; hide it so the
        // panel area is free for the Debug Console. Any failure path above returns early,
        // so the log stays up whenever there is something to read in it.
        if (started && vscode.workspace.getConfiguration('Beguilex').get<boolean>('closeOutputOnDebugLaunch')) {
            outputChannel.hide();
        }
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

    // Push `beguiler.syntaxHints` to the server whenever it changes, so toggling the setting
    // takes effect without a reload (completion is pulled per keystroke).
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('beguiler.syntaxHints')) { sendConfigToLsp(); }
        })
    );

    lspClient.start().then(() => {
        outputChannel.appendLine('[Beguilex] LSP client connected');
        // Re-assert the entry point + pushed settings on every (re)connect so they survive restarts.
        sendEntryPointToLsp();
        sendConfigToLsp();
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

    // --- Asset watcher: refresh the virtual `_blorbAssets.bgl` enum without a keystroke ---
    // The language server live-scans the asset directory on every reparse to resolve the
    // image/sound `eAssets` enum (see beguiler lspServer.cpp). That only fires when the DOCUMENT
    // changes, so dropping a new image into assets/ wouldn't surface until the user typed. This
    // watcher nudges the server on asset-file changes by re-sending the open .bgl buffer as a
    // full-document didChange — the server reparses the LIVE buffer (preserving unsaved edits)
    // and re-runs the scan. A broad glob covers any asset dir name (default assets/, or a custom
    // blorbAssetPath like media/); reparse is cheap and gated to open .bgl docs.
    const assetWatcher = vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg,aiff,aif}');
    const syntheticVersions = new Map<string, number>();
    const nudgeOpenBglDocs = () => {
        if (!lspClient || lspClient.state !== State.Running) { return; }
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId !== 'beguile' || doc.uri.scheme !== 'file') { continue; }
            const key = doc.uri.toString();
            // Advance a synthetic version above whatever the server last saw (open/change/save
            // all use doc.version; start above it, then keep incrementing so it never regresses).
            const next = (syntheticVersions.get(key) ?? doc.version) + 1;
            syntheticVersions.set(key, next);
            lspClient.sendNotification('textDocument/didChange', {
                textDocument: { uri: key, version: next },
                contentChanges: [{ text: doc.getText() }],   // whole-document replace (no range)
            }).catch(() => { /* server not ready; next change will catch up */ });
        }
    };
    assetWatcher.onDidCreate(nudgeOpenBglDocs);
    assetWatcher.onDidDelete(nudgeOpenBglDocs);
    assetWatcher.onDidChange(nudgeOpenBglDocs);
    context.subscriptions.push(assetWatcher);

    // ── Entry point: status bar + command + F5 wiring ────────────────────────
    // The entry point is the .bgl that F5/Debug/Play compiles, and the root the LSP parses
    // included files against (so their #if gating & cross-file symbols resolve). Persisted
    // per-workspace. A status-bar item shows the current entry point and opens the picker.
    beguileEntryPoint = context.workspaceState.get<string>(ENTRY_POINT_STATE_KEY) || undefined;
    if (beguileEntryPoint && !fs.existsSync(beguileEntryPoint)) { beguileEntryPoint = undefined; }
    lastLaunchedBglPath = context.workspaceState.get<string>(LAST_LAUNCHED_STATE_KEY) || undefined;
    if (lastLaunchedBglPath && !fs.existsSync(lastLaunchedBglPath)) { lastLaunchedBglPath = undefined; }

    const entryStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    // Case-insensitive path equality — used to decide whether the ACTIVE editor is the entry point
    // (drives the status-bar text/highlight). The menu Set↔Clear toggle instead keys off the
    // `beguile.entryPointPaths` context key (see refreshEntryUi).
    const sameFile = (a: string | undefined, b: string | undefined) =>
        !!a && !!b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

    // Refresh the status bar + the `beguile.entryPointPaths` context key from the current state and
    // the active editor. Called on activation, entry-point changes, and active-editor switches.
    // The context key is an array (0 or 1 path) so menus can toggle Set↔Clear via `resourcePath in
    // beguile.entryPointPaths` — which works in the explorer too (no active-editor dependency).
    const refreshEntryUi = () => {
        const activeEditor = vscode.window.activeTextEditor;
        const activePath = activeEditor?.document.uri.fsPath;
        const activeIsBgl = !!activePath &&
            (activeEditor?.document.languageId === 'beguile' || activePath.toLowerCase().endsWith('.bgl'));
        const activeIsEntry = sameFile(activePath, beguileEntryPoint);
        vscode.commands.executeCommand('setContext', 'beguile.entryPointPaths', beguileEntryPoint ? [beguileEntryPoint] : []);

        if (activeIsEntry) {
            // On the entry-point file → highlighted, one-click clear.
            entryStatusItem.text = '$(rocket) Clear entry point';
            entryStatusItem.tooltip = `This file is the Beguile entry point.\nF5 / Debug / Play compile it; included files resolve #if highlighting against it.\nClick to clear (return to “run whichever file is open”).`;
            entryStatusItem.command = 'beguile.clearEntryPoint';
            entryStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            entryStatusItem.show();
        } else if (activeIsBgl) {
            // On a .bgl that is NOT the entry point → set THIS file directly (no picker/dropdown).
            entryStatusItem.text = '$(rocket) Set entry point';
            entryStatusItem.tooltip = `Set ${path.basename(activePath!)} as the Beguile entry point.\nF5 / Debug / Play will compile it, and included files resolve #if highlighting against it.`;
            entryStatusItem.command = { title: 'Set Entry Point', command: 'beguile.setEntryPoint', arguments: [vscode.Uri.file(activePath!)] };
            entryStatusItem.backgroundColor = undefined;
            entryStatusItem.show();
        } else if (beguileEntryPoint) {
            // Not on a .bgl, but an entry point is set → show it; clicking reveals/opens it.
            entryStatusItem.text = `$(rocket) Beguile: ${path.basename(beguileEntryPoint)}`;
            entryStatusItem.tooltip = `Beguile entry point: ${beguileEntryPoint}\nClick to reveal it.`;
            entryStatusItem.command = 'beguile.revealEntryPoint';
            entryStatusItem.backgroundColor = undefined;
            entryStatusItem.show();
        } else {
            // Not on a .bgl and nothing set → nothing relevant to show.
            entryStatusItem.hide();
        }
    };
    context.subscriptions.push(entryStatusItem);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => refreshEntryUi())
    );
    refreshEntryUi();
    // Push the persisted entry point to the server now in case the client connected first.
    sendEntryPointToLsp();

    const applyEntryPoint = async (fsPath: string | undefined) => {
        beguileEntryPoint = fsPath;
        await context.workspaceState.update(ENTRY_POINT_STATE_KEY, beguileEntryPoint ?? undefined);
        refreshEntryUi();
        sendEntryPointToLsp();
        // Reparse open .bgl buffers so #if graying in included files updates immediately.
        nudgeOpenBglDocs();
        vscode.window.setStatusBarMessage(
            beguileEntryPoint ? `Beguile entry point → ${path.basename(beguileEntryPoint)}` : 'Beguile entry point cleared', 3000);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.setEntryPoint', async (resource?: vscode.Uri) => {
            // Invoked from the editor/explorer context menu with a .bgl resource → set it directly.
            if (resource && resource.fsPath && resource.fsPath.toLowerCase().endsWith('.bgl')) {
                await applyEntryPoint(resource.fsPath);
                return;
            }
            // Otherwise present a picker: current file, every workspace .bgl, and a clear option.
            const items: (vscode.QuickPickItem & { fsPath?: string; action?: 'clear' })[] = [];
            const active = vscode.window.activeTextEditor;
            if (active && active.document.languageId === 'beguile') {
                items.push({ label: '$(file) Use current file', description: path.basename(active.document.uri.fsPath), fsPath: active.document.uri.fsPath });
            }
            const files = await vscode.workspace.findFiles('**/*.bgl', '**/node_modules/**', 500);
            for (const f of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
                items.push({ label: '$(target) ' + vscode.workspace.asRelativePath(f), description: f.fsPath, fsPath: f.fsPath });
            }
            if (beguileEntryPoint) { items.push({ label: '$(x) Clear entry point', action: 'clear' }); }
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select the Beguile entry-point file (F5 / Debug / Play compile this)', matchOnDescription: true });
            if (!pick) { return; }
            await applyEntryPoint(pick.action === 'clear' ? undefined : pick.fsPath);
        })
    );

    // Clear the entry point → return to “run/highlight whichever file is open”. Ignores its resource
    // arg (menu only surfaces it on the entry-point file), so the status-bar click can call it too.
    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.clearEntryPoint', async () => {
            await applyEntryPoint(undefined);
        })
    );

    // Pure visual indicator for the editor title bar — the rocket shown on the entry-point file.
    // Intentionally does nothing when clicked (the title-bar rocket is an indicator, not a button).
    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.entryPointIndicator', () => { /* no-op: indicator only */ })
    );

    // Reveal the entry-point file: open it in an editor and highlight it in the Explorer. Bound to
    // the status-bar click when a different file is active (replaces the old picker dropdown).
    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.revealEntryPoint', async () => {
            if (!beguileEntryPoint || !fs.existsSync(beguileEntryPoint)) {
                // Nothing to reveal — fall back to the picker so the click still does something useful.
                await vscode.commands.executeCommand('beguile.setEntryPoint');
                return;
            }
            const uri = vscode.Uri.file(beguileEntryPoint);
            await vscode.window.showTextDocument(uri, { preview: false });
            await vscode.commands.executeCommand('revealInExplorer', uri);
        })
    );

    // F5 with no launch.json: resolve an empty/bare `beguile` config by running the Debug command
    // (which compiles the entry point and launches). Returning undefined aborts the default launch
    // so we don't double-start. A fully-specified config (user launch.json) passes through.
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('beguile', {
            resolveDebugConfiguration: (_folder, config) => {
                // beguile.debug builds a rich config (storyPath/bgldbgPath/…) and launches it — that
                // passes through. A bare F5 config (no storyPath) means the user pressed F5 without a
                // launch.json: run beguile.debug (compiles the entry point + launches) and abort the
                // default launch by returning undefined, so we don't start an empty session.
                if (!config.storyPath) {
                    vscode.commands.executeCommand('beguile.debug');
                    return undefined;
                }
                return config;
            },
        })
    );

    outputChannel.appendLine('[Beguilex] LSP client starting: ' + lspBin + ' --lsp ' + lspArgs);
}

export async function deactivate() {
    if (lspClient) { await lspClient.stop(); }
}
