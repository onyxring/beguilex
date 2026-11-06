# Changelog

## [Unreleased]

- A **Create Patch** button on any open Inform 6 file, and **Create I6 Patch**,
  **Edit I6 Patch** and **Add I6 File to Patch** commands
  (and "Edit patch" / "Add file to patch" lenses above each `#mergeI6`) make the
  patches `#mergeI6` applies: edit copies of one or more Inform 6 files, and each
  save rewrites the patch. While a copy is open the editor is in patch mode:
  the status bar and the top of the copy say that saving writes the patch, with
  Open patch and Stop editing patch. Merge chunks that no longer match
  after a library update are shown beside the copy to redo.
- `#mergeI6` is colored as a directive and completes patch names.
- The debugger finds included Inform 6 files in the order Inform 6 searches
  them, so it shows a patched copy rather than the original.

## [0.1.0-preview] - 2026-08-16

Initial public preview release.

Editor support for the Beguile interactive fiction language: syntax
highlighting, semantic tokens, completions, hovers, go to definition, an
integrated step debugger, and an embedded Z-Machine interpreter for playing
and debugging story files without leaving the editor.

This is an experimental preview. The extension and underlying compiler are
evolving actively; expect breaking changes between preview versions.
