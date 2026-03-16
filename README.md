# Beguile Language Support for VSCode

Syntax highlighting for `.bgl` files written in the [Beguile](https://github.com/onyxring/beguile) Interactive Fiction language — the ORBIT (OnyxRing Beguile-Inform Transpiler) source language that compiles to Inform 6 for Glulx and Z-machine targets.

## Features

- Syntax highlighting for all Beguile language constructs:
  - Keywords, control flow, type declarations
  - String, character, and dictionary word literals
  - Integer literals
  - Preprocessor directives (`#include`, `#once`, `#define`, `#if`/`#endif`, `#i6`, `#beguilerSettings`)
  - Raw Inform 6 blocks (`#i6 { }` and `#i6raw { }`)
  - Emitter substitution variables (`$self`, `$prop`)
  - Comments (`//` and `/* */`)
- Bracket matching and auto-close for `{}`, `[]`, `()`, `<>`, `""`, `''`
- Auto-indentation

## Planned Features

- Autocomplete (Language Server)
- Diagnostics / error highlighting
- Embedded Parchment interpreter (run games in-editor)
- Runtime debugger (via Debug Adapter Protocol + beguiler source maps)

## Usage

Open any `.bgl` file — highlighting activates automatically.

## Development

To test locally:
1. Open this folder in VSCode
2. Press **F5** to launch the Extension Development Host
3. Open a `.bgl` file in the new window
4. Use **Developer: Inspect Editor Tokens and Scopes** to verify token scopes
