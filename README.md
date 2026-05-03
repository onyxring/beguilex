# Beguilex — Beguile Language Extension for VS Code


![Beguile](images/beguileLogo.png)

Editor support, integrated build, and a full debugger for [Beguile](https://github.com/onyxring/beguile) — an Interactive Fiction language that compiles via Inform 6 to the Glulx and Z-machine platforms.

## Status: Preview

This is an **experimental preview**. Expect breaking changes alongside compiler updates. Feedback and bug reports are welcome via [GitHub Issues](https://github.com/onyxring/beguilex/issues).

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

## Install

Download the latest `.vsix` from [Releases](https://github.com/onyxring/beguilex/releases), then:

```sh
code --install-extension beguile-language-0.1.0-preview.1.vsix
```

Or in VS Code: **Extensions** view → `⋯` menu → **Install from VSIX...**

## Requirements

- [beguiler](https://github.com/onyxring/beguile) — the Beguile-to-Inform 6 transpiler. Download a binary from its [Releases](https://github.com/onyxring/beguile/releases) and ensure it's on your `PATH` (or configure the path in extension settings).
- Inform 6 compiler (invoked automatically by beguiler)

## Build from source

```sh
npm install
npm run compile
npx vsce package
```

## License

MIT — see [LICENSE](LICENSE).
