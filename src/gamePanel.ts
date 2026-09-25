/**
 * gamePanel.ts
 * VS Code WebView panel that plays an interactive fiction story file.
 *
 * Architecture: the interpreter runs INSIDE the WebView (a real Chromium
 * browser context), not in the extension host.  The extension host only
 * reads the compiled story file and passes it to the WebView as base64.
 *
 * Libraries loaded in the WebView (served as local resources from node_modules):
 *   quixe/src/quixe/lib/jquery-1.12.4.min.js  — required by GiLoad
 *   quixe/src/quixe/lib/glkote.min.js          — GlkOte display layer + Glk API
 *   quixe/src/quixe/lib/quixe.min.js           — Quixe (Glulx) engine + GiLoad
 *   ifvms/dist/zvm.js                           — ZVM (Z-machine) engine
 *
 * Message protocol  (extension host → WebView):
 *   { type: 'startGame', storyBase64: string, isZMachine: boolean }
 *   { type: 'error',     msg: string }
 *
 * For future debugging (Phase 2):
 *   Wrap window.GlkOte.update in the WebView script to intercept VM updates,
 *   then postMessage breakpoint events back to the extension host.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveIsLight, themeColors } from './themeUtils';

const Z_MACHINE_EXTS = new Set(['.z3', '.z5', '.z6', '.z8', '.zblorb']);

export class GamePanel {
    static readonly viewType = 'beguile.gamePanel';

    /** The panel from the previous Play, so a re-run replaces it instead of stacking. */
    private static current: GamePanel | undefined;

    private panel: vscode.WebviewPanel;
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];

    static create(context: vscode.ExtensionContext, storyPath: string): GamePanel {
        const ext = path.extname(storyPath).toLowerCase();
        const isZMachine = Z_MACHINE_EXTS.has(ext);
        const nmRoot = path.join(context.extensionPath, 'node_modules');
        const title = `Play: ${path.basename(storyPath)}`;

        // Take over the previous panel where it stands. Only reuse preserves a placement
        // the user chose by dragging — a ViewColumn cannot name a detached window, and
        // there is no API that can open one there.
        const reuse = GamePanel.current?.release();
        const panel = reuse ?? vscode.window.createWebviewPanel(
            GamePanel.viewType,
            title,
            context.globalState.get<vscode.ViewColumn>('gamePanelColumn', vscode.ViewColumn.Beside),
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(nmRoot, 'quixe')),
                    vscode.Uri.file(path.join(nmRoot, 'ifvms')),
                ]
            }
        );
        if (reuse) {
            reuse.title = title;
            reuse.reveal(undefined, false); // undefined column = stay put; take focus
        }

        GamePanel.current = new GamePanel(panel, context, storyPath, isZMachine);
        return GamePanel.current;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        storyPath: string,
        isZMachine: boolean
    ) {
        this.panel = panel;
        this.context = context;
        this.panel.webview.html = this.buildHtml(context, isZMachine);
        this.panel.onDidDispose(() => {
            if (GamePanel.current === this) { GamePanel.current = undefined; }
            this.dispose();
        }, null, this.disposables);

        // Track the column as it moves, so a Play that has to create a fresh panel opens
        // it where the last one was left.
        this.panel.onDidChangeViewState(e => {
            if (e.webviewPanel.viewColumn !== undefined) {
                this.context.globalState.update('gamePanelColumn', e.webviewPanel.viewColumn);
            }
        }, null, this.disposables);

        const sendTheme = () => this.panel.webview.postMessage(
            { type: 'setTheme', ...themeColors(resolveIsLight()) }
        );
        vscode.window.onDidChangeActiveColorTheme(() => sendTheme(), null, this.disposables);
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('beguile.interpreterTheme')) sendTheme();
        }, null, this.disposables);

        // Wait for the document to announce itself rather than guessing at a delay — a reused
        // panel reloads asynchronously, and anything sent before the listener exists is lost.
        this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
            if (msg?.type !== 'ready') { return; }
            try {
                const buffer = fs.readFileSync(storyPath);
                this.panel.webview.postMessage({
                    type: 'startGame',
                    storyBase64: buffer.toString('base64'),
                    isZMachine
                });
            } catch (e) {
                this.panel.webview.postMessage({ type: 'error', msg: String(e) });
            }
        }, null, this.disposables);
    }

    private buildHtml(context: vscode.ExtensionContext, isZMachine: boolean): string {
        const w = this.panel.webview;
        const { bg, fg, inputClr, accentBg, markBg, loadClr } = themeColors(resolveIsLight());

        const nm = (...parts: string[]): vscode.Uri =>
            w.asWebviewUri(vscode.Uri.file(
                path.join(context.extensionPath, 'node_modules', ...parts)
            ));

        const jqueryJs  = nm('quixe', 'src', 'quixe', 'lib', 'jquery-1.12.4.min.js');
        const glkoteJs  = nm('quixe', 'src', 'quixe', 'lib', 'glkote.min.js');
        const quixeJs   = nm('quixe', 'src', 'quixe', 'lib', 'quixe.min.js');
        const glkoteCss = nm('quixe', 'src', 'quixe', 'media', 'i7-glkote.css');
        const dialogCss = nm('quixe', 'src', 'quixe', 'media', 'dialog.css');
        const zvmJs     = nm('ifvms', 'dist', 'zvm.js');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- Unique per load. Setting webview.html to an IDENTICAL string is a no-op in VS Code, so a
     reused panel would keep its old document — and Quixe refuses to initialise twice in one page. -->
<meta name="bgl-run" content="${Date.now()}-${Math.random().toString(36).slice(2)}">
<meta name="viewport" content="width=device-width, user-scalable=no">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${w.cspSource} data:;
           style-src ${w.cspSource} 'unsafe-inline';
           script-src ${w.cspSource} 'unsafe-inline' 'unsafe-eval';">
<link rel="stylesheet" href="${glkoteCss}">
<link rel="stylesheet" href="${dialogCss}">
<style>
  :root {
    --bgl-bg: ${bg}; --bgl-fg: ${fg}; --bgl-input: ${inputClr};
    --bgl-accent: ${accentBg}; --bgl-mark: ${markBg}; --bgl-load: ${loadClr};
  }
  html, body {
    height: 100%; width: 100%; margin: 0; padding: 0;
    background: var(--bgl-bg);
    color: var(--bgl-fg);
  }

  /* Centred game column, max 900px — matches Parchment's gameport layout */
  #gameport {
    bottom: 0; left: 0; right: 0; top: 0;
    margin: 0 auto;
    max-width: 900px;
    position: absolute;
    overflow: clip;
  }

  #windowport { height: 100%; position: relative; width: 100%; }

  #loadingpane { color: var(--bgl-load); padding: 16px; font-family: monospace; text-align: center; top: 20%; position: absolute; width: 100%; }

  .WindowFrame { background: var(--bgl-bg); }

  .BufferWindow {
    background: var(--bgl-bg);
    color: var(--bgl-fg);
    font-family: Georgia, serif;
    font-size: 15px;
    line-height: 1.4;
    padding: 6px 10px;
    overflow: scroll;
    overflow-x: hidden;
  }

  .GridWindow {
    background: var(--bgl-fg);
    color: var(--bgl-bg);
    font-family: "Lucida Console", "DejaVu Sans Mono", monospace;
    font-size: 14px;
    line-height: 18px;
    padding: 6px 10px;
    overflow: hidden;
  }

  .GridLine { white-space: pre; }

  .Input { color: var(--bgl-input); font-weight: bold; border: none; margin: 0; padding: 0; outline: none; background: none; }
  .BufferWindow .Input { font-family: Georgia, serif; font-size: 15px; }
  .GridWindow   .Input { font-family: "Lucida Console", "DejaVu Sans Mono", monospace; font-size: 14px; }

  /* Glk styles */
  .Style_normal     { }
  .Style_emphasized { font-style: italic; }
  .Style_preformatted { font-family: "Lucida Console", "DejaVu Sans Mono", monospace; }
  .Style_header     { font-weight: bold; font-size: 17px; }
  .Style_subheader  { font-weight: bold; }
  .Style_alert      { font-weight: bold; }
  .Style_note       { font-style: italic; }
  .Style_blockquote { background: var(--bgl-accent); }
  .Style_input      { color: var(--bgl-input); font-weight: bold; }

  .Style_reverse, span[class*="reverse"] { background: var(--bgl-accent); color: var(--bgl-fg); }

  .InvisibleCursor { position: relative; padding-bottom: 14px; }
  .MorePrompt { font-weight: bold; position: absolute; background: var(--bgl-accent); color: var(--bgl-fg); opacity: 0.8; padding: 2px 6px; border-radius: 4px; }
  .PreviousMark { position: absolute; background: var(--bgl-mark); height: 2px; width: 12px; top: 0; right: 0; }
</style>
<title>Beguile Game</title>
</head>
<body>
<div id="gameport">
  <div id="windowport"></div>
  <div id="loadingpane">Loading…</div>
  <div id="errorpane" style="display:none;"><div id="errorcontent"></div></div>
</div>

<script src="${jqueryJs}"></script>
<script src="${glkoteJs}"></script>
<script src="${quixeJs}"></script>
${isZMachine ? `<script src="${zvmJs}"></script>` : ''}

<script>
(function () {
    var vscode = acquireVsCodeApi();

    vscode.postMessage({ type: 'ready' });
    window.addEventListener('message', function (event) {
        var msg = event.data;

        if (msg.type === 'startGame') {
            // Decode base64 → byte array. Use Uint8Array for ZVM (requires TypedArray/ArrayBuffer);
            // plain Array is fine for Quixe.
            var binary = atob(msg.storyBase64);
            var storyArray = msg.isZMachine ? new Uint8Array(binary.length) : new Array(binary.length);
            for (var i = 0; i < binary.length; i++) {
                storyArray[i] = binary.charCodeAt(i);
            }

            /* ZVM is a class constructor; GiLoad expects a singleton with prepare()/resume()
               on it directly, so instantiate first. ZVM.prepare() also requires options.Glk
               (GiLoad only sets options.io, not options.Glk).
               GiDispa is the Quixe/Glulx dispatch layer; ZVM has its own Glk bindings and
               must not have GiDispa attached (it causes retain_array errors on line input). */
            if (msg.isZMachine) { window.ZVM = new ZVM(); window.GiDispa = null; }
            var vm  = msg.isZMachine ? ZVM : Quixe;
            var glkOpt = msg.isZMachine ? { Glk: window.Glk } : {};

            GiLoad.load_run(Object.assign({ vm: vm, use_query_story: false }, glkOpt), storyArray, 'array');

        } else if (msg.type === 'setTheme') {
            var r = document.documentElement.style;
            r.setProperty('--bgl-bg',     msg.bg);
            r.setProperty('--bgl-fg',     msg.fg);
            r.setProperty('--bgl-input',  msg.inputClr);
            r.setProperty('--bgl-accent', msg.accentBg);
            r.setProperty('--bgl-mark',   msg.markBg);
            r.setProperty('--bgl-load',   msg.loadClr);
        } else if (msg.type === 'error') {
            document.getElementById('errorcontent').textContent = msg.msg;
            document.getElementById('errorpane').style.display = '';
            document.getElementById('loadingpane').style.display = 'none';
        }
    });
}());
</script>
</body>
</html>`;
    }

    /** Tear this instance down but leave the panel open, for the next Play to adopt. */
    private release(): vscode.WebviewPanel {
        if (GamePanel.current === this) { GamePanel.current = undefined; }
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        return this.panel;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
