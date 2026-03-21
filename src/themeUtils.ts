import * as vscode from 'vscode';

export interface ThemeColors {
    bg:       string;
    fg:       string;
    inputClr: string;
    accentBg: string;
    markBg:   string;
    loadClr:  string;
}

export function resolveIsLight(): boolean {
    const s = vscode.workspace.getConfiguration('beguile').get<string>('interpreterTheme') ?? 'auto';
    return s === 'light' ||
        (s === 'auto' && vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light);
}

export function themeColors(isLight: boolean): ThemeColors {
    return {
        bg:       isLight ? '#f5f0e8' : '#111',
        fg:       isLight ? '#222'    : '#ddd',
        inputClr: isLight ? '#1a4a8a' : '#7db2e8',
        accentBg: isLight ? '#e8e0d0' : '#292929',
        markBg:   isLight ? '#ccc'    : '#444',
        loadClr:  isLight ? '#888'    : '#666',
    };
}
