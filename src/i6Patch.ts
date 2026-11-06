// Create and edit the patches `#mergeI6` applies to Inform 6 files. The developer edits a copy of the
// I6 file; each save has beguiler write the patch from the original and the copy, so nobody edits a
// diff by hand.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { LanguageClient } from 'vscode-languageclient/node';

interface PatchSession {
    patchPath: string;
    pairs: { original: string; copy: string }[];
}

interface PatchInfo {
    patchPath: string;
    targets: { name: string; original: string }[];
}

const SESSIONS_KEY = 'beguile.i6PatchSessions';
const MERGE_RE = /^\s*#mergeI6\s*\??\s*"([^"]*)"/i;

export function registerI6PatchCommands(
    context: vscode.ExtensionContext,
    getClient: () => LanguageClient | undefined,
    getBeguiler: () => string,
): void {
    const sessions = (): PatchSession[] => context.workspaceState.get<PatchSession[]>(SESSIONS_KEY, []);
    const sessionFor = (copy: string) => sessions().find(s => s.pairs.some(p => samePath(p.copy, copy)));
    const sessionsChanged = new vscode.EventEmitter<void>();
    const saveSession = async (session: PatchSession) => {
        const rest = sessions().filter(s => !samePath(s.patchPath, session.patchPath));
        await context.workspaceState.update(SESSIONS_KEY, [...rest, session]);
        sessionsChanged.fire();
    };
    const dropSession = async (patchPath: string) => {
        await context.workspaceState.update(SESSIONS_KEY, sessions().filter(s => !samePath(s.patchPath, patchPath)));
        sessionsChanged.fire();
    };

    // Patch mode: while a copy is the active editor, the status bar says that saving writes the patch.
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    let flashUntil = 0;
    const updatePatchMode = () => {
        const doc = vscode.window.activeTextEditor?.document;
        const session = doc ? sessionFor(doc.fileName) : undefined;
        void vscode.commands.executeCommand('setContext', 'beguile.inI6PatchCopy', !!session);
        if (!session || !doc) { status.hide(); return; }
        const patch = path.basename(session.patchPath);
        if (Date.now() >= flashUntil) { status.text = `$(diff) Patch mode: saving writes ${patch}`; }
        status.tooltip = `This is a copy of ${sessionPair(session, doc.fileName)!.original}.\n` +
            `Saving it writes ${session.patchPath}; the Inform 6 file itself doesn't change.\nClick to open the patch.`;
        status.command = { title: 'Open patch', command: 'beguile.openI6PatchFile', arguments: [session.patchPath] };
        status.show();
    };
    const flash = (text: string) => {
        status.text = text;
        flashUntil = Date.now() + 3000;
        setTimeout(updatePatchMode, 3000);
    };

    const runBeguiler = (args: string[]) => new Promise<{ ok: boolean; out: string; err: string }>(resolve => {
        execFile(getBeguiler(), args, (error, stdout, stderr) =>
            resolve({ ok: !error, out: stdout.toString(), err: stderr.toString() || (error ? error.message : '') }));
    });

    // The copy of `original` for a patch, in the extension's storage: one folder per patch.
    const copyPathFor = (patchPath: string, original: string) => {
        const id = crypto.createHash('sha1').update(path.resolve(patchPath)).digest('hex').slice(0, 10);
        const dir = path.join(context.globalStorageUri.fsPath, 'i6patches', `${path.basename(patchPath, path.extname(patchPath))}-${id}`);
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, path.basename(original));
    };

    const openCopies = async (session: PatchSession) => {
        for (const [i, pair] of session.pairs.entries()) {
            const doc = await vscode.workspace.openTextDocument(pair.copy);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: i > 0 });
        }
        const names = session.pairs.map(p => path.basename(p.original)).join(', ');
        updatePatchMode();
        vscode.window.showInformationMessage(
            `Patch mode: you're editing a copy of ${names}. Saving writes ${path.basename(session.patchPath)}; ` +
            'the Inform 6 file itself doesn\'t change.');
    };

    // Ends patch mode for a patch: offers to save unsaved copies (which writes the patch), then closes them.
    const stopEditing = async (patchPath?: string) => {
        const session = patchPath ? sessions().find(s => samePath(s.patchPath, patchPath))
            : sessionFor(vscode.window.activeTextEditor?.document.fileName ?? '');
        if (!session) { return; }
        const docs = vscode.workspace.textDocuments.filter(d => session.pairs.some(p => samePath(p.copy, d.fileName)));
        if (docs.some(d => d.isDirty)) {
            const choice = await vscode.window.showWarningMessage(
                `Save the copies first? Saving writes ${path.basename(session.patchPath)}.`, { modal: true }, 'Save', 'Discard');
            if (!choice) { return; }
            if (choice === 'Save') { for (const d of docs) { await d.save(); } }
        }
        await dropSession(session.patchPath);
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
            t.input instanceof vscode.TabInputText && session.pairs.some(p => samePath(p.copy, (t.input as vscode.TabInputText).uri.fsPath)));
        await vscode.window.tabGroups.close(tabs, true);
        updatePatchMode();
    };

    // The Inform 6 files the developer picks, from those the document can reach, leaving out `exclude`.
    const pickI6Files = async (doc: vscode.TextDocument, placeHolder: string, exclude: string[] = []) => {
        const client = getClient();
        if (!client) { vscode.window.showErrorMessage('The Beguile language server is not running.'); return undefined; }
        const files = await client.sendRequest<{ name: string; path: string }[]>('beguile/i6Files', { uri: doc.uri.toString() });
        const picks = await vscode.window.showQuickPick(
            files.filter(f => !exclude.some(e => samePath(e, f.path))).map(f => ({ label: f.name, detail: f.path })),
            { placeHolder, matchOnDetail: true, canPickMany: true });
        return picks && picks.length ? picks.map(p => p.detail!) : undefined;
    };

    // Starts a patch of one or more I6 files. `name` is set when a #mergeI6 line already names the patch.
    const createPatch = async (doc: vscode.TextDocument, name?: string) => {
        const originals = await pickI6Files(doc, 'The Inform 6 files to patch');
        if (!originals) { return; }
        const insertLine = name === undefined;
        if (name === undefined) {
            name = await vscode.window.showInputBox({
                prompt: 'Name of the patch, saved beside this file',
                value: path.basename(doc.fileName, path.extname(doc.fileName)),
                validateInput: v => /^[\w.\-/]+$/.test(v) ? undefined : 'Use letters, digits, ., - and _',
            });
            if (!name) { return; }
        }
        const patchPath = path.resolve(path.dirname(doc.fileName), name.endsWith('.patch') || name.endsWith('.diff') ? name : `${name}.patch`);
        if (fs.existsSync(patchPath)) {
            vscode.window.showErrorMessage(`${path.basename(patchPath)} already exists; use Edit patch or Add file to patch on its #mergeI6 line.`);
            return;
        }
        if (insertLine) {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(mergeInsertLine(doc), 0), `#mergeI6 "${name}"\n`);
            await vscode.workspace.applyEdit(edit);
        }
        const session: PatchSession = { patchPath, pairs: [] };
        for (const original of originals) {
            const copy = copyPathFor(patchPath, original);
            fs.copyFileSync(original, copy);
            session.pairs.push({ original, copy });
        }
        await saveSession(session);
        await openCopies(session);
    };

    // From an open Inform 6 file: patch it for an extension (whose .bgl gets the #mergeI6), or save the
    // patch wherever the developer picks.
    const createFromI6File = async (uri?: vscode.Uri) => {
        const original = uri?.fsPath ?? vscode.window.activeTextEditor?.document.fileName;
        if (!original) { return; }
        const bgls = (await vscode.workspace.findFiles('**/*.bgl', '**/{output,node_modules}/**'))
            .map(u => u.fsPath).filter(f => !f.endsWith('_blorbAssets.bgl'));
        const recent = context.workspaceState.get<string>('beguile.lastPatchExtension');
        bgls.sort((a, b) => (samePath(b, recent ?? '') ? 1 : 0) - (samePath(a, recent ?? '') ? 1 : 0) || a.localeCompare(b));
        const elsewhere = '$(folder) Choose where to save the patch…';
        const pick = await vscode.window.showQuickPick(
            [...bgls.map(f => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(path.dirname(f)), file: f })),
             { label: elsewhere, description: 'no extension gets a #mergeI6 line', file: '' }],
            { placeHolder: `Which extension is the patch of ${path.basename(original)} for?`, matchOnDescription: true });
        if (!pick) { return; }
        let patchPath: string, bgl: string | undefined;
        if (pick.file) {
            bgl = pick.file;
            await context.workspaceState.update('beguile.lastPatchExtension', bgl);
            const name = await vscode.window.showInputBox({
                prompt: `Name of the patch, saved beside ${path.basename(bgl)}`,
                value: path.basename(bgl, '.bgl'),
                validateInput: v => /^[\w.\-/]+$/.test(v) ? undefined : 'Use letters, digits, ., - and _',
            });
            if (!name) { return; }
            patchPath = path.resolve(path.dirname(bgl), name.endsWith('.patch') || name.endsWith('.diff') ? name : `${name}.patch`);
        } else {
            const target = await vscode.window.showSaveDialog({ filters: { 'Patch': ['patch', 'diff'] }, saveLabel: 'Create patch' });
            if (!target) { return; }
            patchPath = target.fsPath;
        }
        if (fs.existsSync(patchPath)) {
            vscode.window.showErrorMessage(`${path.basename(patchPath)} already exists; use Edit patch or Add file to patch above its #mergeI6 line.`);
            return;
        }
        if (bgl) {
            const doc = await vscode.workspace.openTextDocument(bgl);
            const name = path.relative(path.dirname(bgl), patchPath).replace(/\\/g, '/').replace(/\.patch$/, '');
            if (!doc.getText().split(/\r?\n/).some(l => MERGE_RE.exec(l)?.[1] === name)) {
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, new vscode.Position(mergeInsertLine(doc), 0), `#mergeI6 "${name}"\n`);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }
        }
        const copy = copyPathFor(patchPath, original);
        fs.copyFileSync(original, copy);
        const session = { patchPath, pairs: [{ original, copy }] };
        await saveSession(session);
        // The copy takes the original's place, so there is one tab for the file and it is the patch copy.
        const originalTab = vscode.window.tabGroups.activeTabGroup.tabs.find(t =>
            t.input instanceof vscode.TabInputText && samePath(t.input.uri.fsPath, original));
        await openCopies(session);
        if (originalTab && !originalTab.isDirty) { await vscode.window.tabGroups.close(originalTab, true); }
    };

    // Opens the patch on a #mergeI6 line for editing; with `addFiles`, first asks for more I6 files to
    // patch, whose copies start unchanged.
    const editPatch = async (uri?: vscode.Uri, line?: number, addFiles = false) => {
        const editor = vscode.window.activeTextEditor;
        const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
        if (!doc) { return; }
        line = line ?? editor?.selection.active.line ?? 0;
        const merge = MERGE_RE.exec(doc.lineAt(line).text);
        if (!merge) { vscode.window.showErrorMessage('Put the cursor on a #mergeI6 line.'); return; }
        const client = getClient();
        if (!client) { vscode.window.showErrorMessage('The Beguile language server is not running.'); return; }
        const info = await client.sendRequest<PatchInfo | null>('beguile/i6PatchInfo', { uri: doc.uri.toString(), line });
        if (!info) { vscode.window.showErrorMessage('The language server has not read this #mergeI6 yet; try again in a moment.'); return; }
        if (!info.patchPath) { await createPatch(doc, merge[1]); return; }
        let added: string[] = [];
        if (addFiles) {
            added = await pickI6Files(doc, `Inform 6 files to add to ${path.basename(info.patchPath)}`, info.targets.map(t => t.original)) ?? [];
            if (!added.length) { return; }
        }
        const missing = info.targets.filter(t => !t.original);
        if (missing.length) {
            vscode.window.showErrorMessage(`Can't find ${missing.map(t => t.name).join(', ')} on the include paths.`);
            return;
        }
        const session: PatchSession = { patchPath: info.patchPath, pairs: [] };
        const failed: string[] = [];
        for (const t of info.targets) {
            const copy = copyPathFor(info.patchPath, t.original);
            const r = await runBeguiler(['--apply-patch', info.patchPath, t.original, '-o', copy]);
            if (!r.ok) { vscode.window.showErrorMessage(r.err.trim()); return; }
            const result = JSON.parse(r.out) as { applied: number; failed: string[] };
            failed.push(...result.failed.map(h => `${path.basename(t.original)}\n${h}`));
            session.pairs.push({ original: t.original, copy });
        }
        for (const original of added) {
            const copy = copyPathFor(info.patchPath, original);
            fs.copyFileSync(original, copy);
            session.pairs.push({ original, copy });
        }
        await saveSession(session);
        await openCopies(session);
        if (failed.length) {
            const rejects = await vscode.workspace.openTextDocument({ language: 'diff', content: failed.join('\n') });
            await vscode.window.showTextDocument(rejects, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
            vscode.window.showWarningMessage(
                `${failed.length} merge chunk(s) in ${path.basename(info.patchPath)} no longer match the file, shown beside it. ` +
                'Make them again in the copy; saving writes the patch without the ones you leave out.');
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('beguile.createI6Patch', async () => {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc || doc.languageId !== 'beguile') { vscode.window.showErrorMessage('Open the .bgl file the patch belongs to.'); return; }
            await createPatch(doc);
        }),
        vscode.commands.registerCommand('beguile.createPatchOfI6File', createFromI6File),
        vscode.commands.registerCommand('beguile.editI6Patch', (uri?: vscode.Uri, line?: number) => editPatch(uri, line)),
        vscode.commands.registerCommand('beguile.addToI6Patch', (uri?: vscode.Uri, line?: number) => editPatch(uri, line, true)),
        vscode.workspace.onDidSaveTextDocument(async doc => {
            const session = sessionFor(doc.fileName);
            if (!session) { return; }
            const args = ['--make-patch', ...session.pairs.flatMap(p => [p.original, p.copy]), '-o', session.patchPath];
            const r = await runBeguiler(args);
            const name = path.basename(session.patchPath);
            if (!r.ok) { vscode.window.showErrorMessage(`${name}: ${r.err.trim()}`); return; }
            if (r.out.trim() === 'no changes') {
                vscode.window.showInformationMessage(`The copy matches the original, so ${name} was not written.`);
                return;
            }
            flash(`$(check) Wrote ${name}`);
        }),
        status, sessionsChanged,
        vscode.window.onDidChangeActiveTextEditor(updatePatchMode),
        sessionsChanged.event(updatePatchMode),
        vscode.commands.registerCommand('beguile.openI6PatchFile', async (patchPath?: string) => {
            patchPath = patchPath ?? sessionFor(vscode.window.activeTextEditor?.document.fileName ?? '')?.patchPath;
            if (!patchPath) { return; }
            if (!fs.existsSync(patchPath)) { vscode.window.showInformationMessage(`${path.basename(patchPath)} hasn't been written yet; save the copy to write it.`); return; }
            await vscode.window.showTextDocument(vscode.Uri.file(patchPath), { preview: true });
        }),
        vscode.commands.registerCommand('beguile.stopI6PatchEditing', (patchPath?: string) => stopEditing(patchPath)),
        // At the top of each copy: what it is and what saving does.
        vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: new vscode.RelativePattern(context.globalStorageUri, 'i6patches/**') }, {
            onDidChangeCodeLenses: sessionsChanged.event,
            provideCodeLenses(doc) {
                const session = sessionFor(doc.fileName);
                if (!session) { return []; }
                const top = new vscode.Range(0, 0, 0, 0);
                const patch = path.basename(session.patchPath);
                return [
                    new vscode.CodeLens(top, { title: `$(diff) Patch copy of ${path.basename(sessionPair(session, doc.fileName)!.original)}: saving writes ${patch}`,
                        command: 'beguile.openI6PatchFile', arguments: [session.patchPath] }),
                    new vscode.CodeLens(top, { title: 'Open patch', command: 'beguile.openI6PatchFile', arguments: [session.patchPath] }),
                    new vscode.CodeLens(top, { title: 'Stop editing patch', command: 'beguile.stopI6PatchEditing', arguments: [session.patchPath] }),
                ];
            },
        }),
        vscode.languages.registerCodeLensProvider({ language: 'beguile' }, {
            provideCodeLenses(doc) {
                const lenses: vscode.CodeLens[] = [];
                for (let i = 0; i < doc.lineCount; i++) {
                    if (!MERGE_RE.test(doc.lineAt(i).text)) { continue; }
                    const at = new vscode.Range(i, 0, i, 0);
                    lenses.push(new vscode.CodeLens(at, { title: 'Edit patch', command: 'beguile.editI6Patch', arguments: [doc.uri, i] }));
                    lenses.push(new vscode.CodeLens(at, { title: 'Add file to patch', command: 'beguile.addToI6Patch', arguments: [doc.uri, i] }));
                }
                return lenses;
            },
        }),
    );
    updatePatchMode();
}

// After the file's leading directives (#once, includes, merges), or at the top.
function mergeInsertLine(doc: vscode.TextDocument): number {
    let after = 0;
    for (let i = 0; i < doc.lineCount; i++) {
        const t = doc.lineAt(i).text.trim();
        if (/^#(once|include|includeI6|mergeI6)\b/i.test(t)) { after = i + 1; continue; }
        if (t === '' || t.startsWith('//')) { continue; }
        break;
    }
    return after;
}

function sessionPair(session: PatchSession, copy: string) {
    return session.pairs.find(p => samePath(p.copy, copy));
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string) => process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase();
    return norm(a) === norm(b);
}
