# Beguilex — Beguile Language Extension for VS Code


![Beguile](images/beguileLogo.png)

Editor support, integrated build, and a full debugger for [Beguile](https://github.com/onyxring/beguile) — an Interactive Fiction language that compiles via Inform 6 to the Glulx and Z-machine platforms.

## Editor

- Syntax and semantic highlighting
- Autocomplete, hover info, signature help, and go-to-definition
- Bracket matching, auto-close, and auto-indentation

## Build & Run

Compile and play .bgl games directly in VS Code using an embedded interpreter panel. Run **Beguile: Play** or **Beguile: Debug** from the Command Palette.

## Debugger

- Breakpoints in .bgl, .inf, and .h source files
- Step over, step into, and step out — at both Beguile and Inform 6 levels
- Step into included I6 library source (parser.h, verblib.h, etc.)
- Locals, globals, and self-property inspection with type-aware object expansion
- Watch expressions, call stack, and runtime variable editing

## Requirements

- [beguiler](https://github.com/onyxring/beguile) — the Beguile-to-Inform 6 transpiler
- Inform 6 compiler (invoked automatically by beguiler)


[def]: image