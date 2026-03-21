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

    private panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    static create(context: vscode.ExtensionContext, storyPath: string): GamePanel {
        const ext = path.extname(storyPath).toLowerCase();
        const isZMachine = Z_MACHINE_EXTS.has(ext);
        const nmRoot = path.join(context.extensionPath, 'node_modules');

        const panel = vscode.window.createWebviewPanel(
            GamePanel.viewType,
            `Play: ${path.basename(storyPath)}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(nmRoot, 'quixe')),
                    vscode.Uri.file(path.join(nmRoot, 'ifvms')),
                ]
            }
        );

        return new GamePanel(panel, context, storyPath, isZMachine);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        storyPath: string,
        isZMachine: boolean
    ) {
        this.panel = panel;
        this.panel.webview.html = this.buildHtml(context, isZMachine);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        const sendTheme = () => this.panel.webview.postMessage(
            { type: 'setTheme', ...themeColors(resolveIsLight()) }
        );
        vscode.window.onDidChangeActiveColorTheme(() => sendTheme(), null, this.disposables);
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('beguile.interpreterTheme')) sendTheme();
        }, null, this.disposables);

        // Give the WebView time to load its scripts before sending story data
        setTimeout(() => {
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
        }, 500);
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

    window.addEventListener('message', function (event) {
        var msg = event.data;

        if (msg.type === 'startGame') {
            // Decode base64 → plain array of byte values (what GiLoad 'array' format expects)
            var binary = atob(msg.storyBase64);
            var storyArray = new Array(binary.length);
            for (var i = 0; i < binary.length; i++) {
                storyArray[i] = binary.charCodeAt(i);
            }

            var vm = msg.isZMachine ? ZVM : Quixe;

            // GiLoad.load_run(options, image, imageFormat)
            //   options.vm  — the engine (Quixe or ZVM)
            //   image       — array of byte values
            //   imageFormat — 'array'
            GiLoad.load_run({ vm: vm, use_query_story: false }, storyArray, 'array');

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

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
