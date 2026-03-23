import * as vscode from 'vscode';

const HISTORY_KEY = 'beguile.variableFilterHistory';
const MAX_HISTORY = 10;

export class VariableFilterViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'beguile.variableFilter';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onFilterChange: (filter: string) => void
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        // Send persisted history once the view is ready
        const history = this.getHistory();
        if (history.length > 0) {
            webviewView.webview.postMessage({ type: 'history', items: history });
        }

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'filter') {
                this.onFilterChange(msg.value as string);
            } else if (msg.type === 'commit') {
                const value = (msg.value as string).trim();
                if (value) {
                    this.addToHistory(value);
                    webviewView.webview.postMessage({ type: 'history', items: this.getHistory() });
                }
            } else if (msg.type === 'remove') {
                this.removeFromHistory(msg.value as string);
                webviewView.webview.postMessage({ type: 'history', items: this.getHistory() });
            }
        });
    }

    clearFilter(): void {
        this._view?.webview.postMessage({ type: 'clear' });
    }

    private getHistory(): string[] {
        return this.context.globalState.get<string[]>(HISTORY_KEY, []);
    }

    private addToHistory(filter: string): void {
        const history = this.getHistory().filter(h => h !== filter);
        history.unshift(filter);
        this.context.globalState.update(HISTORY_KEY, history.slice(0, MAX_HISTORY));
    }

    private removeFromHistory(filter: string): void {
        const history = this.getHistory().filter(h => h !== filter);
        this.context.globalState.update(HISTORY_KEY, history);
    }

    private getHtml(): string {
        const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; }
  body { padding: 4px 8px; box-sizing: border-box; }
  #input-wrap { position: relative; }
  input {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 2px 22px 2px 6px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #clear-btn {
    display: none;
    position: absolute;
    right: 4px; top: 50%;
    transform: translateY(-50%);
    background: none; border: none;
    color: var(--vscode-input-foreground);
    opacity: 0.6;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  #clear-btn:hover { opacity: 1; }
  #history { margin-top: 4px; display: flex; flex-direction: column; gap: 1px; }
  .history-row { position: relative; }
  .chip {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    font-style: italic;
    padding: 1px 22px 1px 6px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%; box-sizing: border-box;
    opacity: 0.7;
  }
  .chip:hover { opacity: 1; }
  .remove-btn {
    position: absolute;
    right: 4px; top: 50%;
    transform: translateY(-50%);
    background: none; border: none;
    color: var(--vscode-foreground);
    opacity: 0.4;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .remove-btn:hover { opacity: 1; }
</style>
</head>
<body>
<div id="input-wrap">
  <input type="text" id="filter" placeholder="Filter variables… (Enter to apply)">
  <button id="clear-btn" tabindex="-1">&#x2715;</button>
</div>
<div id="history"></div>
<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('filter');
    const clearBtn = document.getElementById('clear-btn');
    const historyDiv = document.getElementById('history');

    function updateClearBtn() {
        clearBtn.style.display = input.value ? 'block' : 'none';
    }

    clearBtn.addEventListener('click', () => {
        input.value = '';
        updateClearBtn();
        vscode.postMessage({ type: 'filter', value: '' });
        input.focus();
    });

    input.addEventListener('input', () => {
        updateClearBtn();
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const v = input.value.trim();
            if (v) {
                vscode.postMessage({ type: 'filter', value: v });
                vscode.postMessage({ type: 'commit', value: v });
            }
        }
    });

    function renderHistory(items) {
        historyDiv.innerHTML = '';
        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'history-row';

            const btn = document.createElement('button');
            btn.className = 'chip';
            btn.textContent = item;
            btn.title = item;
            btn.addEventListener('click', () => {
                input.value = item;
                updateClearBtn();
                vscode.postMessage({ type: 'filter', value: item });
                vscode.postMessage({ type: 'commit', value: item });
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '✕';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'remove', value: item });
            });

            row.appendChild(btn);
            row.appendChild(removeBtn);
            historyDiv.appendChild(row);
        });
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'clear') { input.value = ''; updateClearBtn(); }
        else if (msg.type === 'history') { renderHistory(msg.items); }
    });
}());
</script>
</body>
</html>`;
    }
}
