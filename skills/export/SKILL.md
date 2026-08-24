---
name: export
description: Export a document or artifact to PDF, Word, Excel, CSV, HTML, TXT, Markdown or JSON using the FlowForge converter (zero dependencies, works in any project)
argument-hint: "<file or artifact name> [pdf|docx|xlsx|csv|html|txt|md|json] [--out <path>]"
allowed-tools:
  - read
  - glob
  - exec
triggers:
  - user
  - model
---

Produce a real file the user can open, send or print. Use this whenever the user asks for a PDF,
a Word file, an Excel sheet, a printable report or "a document" of something — never hand-write a
converter and never suggest installing a library: the workbench already ships one.

WORKBENCH: read the `workbench` field of `%APPDATA%\devin\flowforge.json` (written by `install.mjs`).
If that file is missing, tell the user to run `node install.mjs` in the workbench clone and stop.

## Resolve the input
1. If the argument is an existing path, use it.
2. If it names a flow artifact (`plan`, `analysis`, `code-notes`, `review`, `debug`, `ship`, `context`,
   `checks`, `understanding`, `report`, `perf`), resolve it under `<project>\.workbench\artifacts\`.
3. If the user described content instead of a file ("export the summary you just wrote"), write that
   content to a temporary `.md` file first, then convert it.
Supported inputs: `.md`, `.markdown`, `.html`, `.htm`, `.txt`, or a directory (converts everything in it).

## Pick the format
Use the format the user named. If they did not name one, infer it:
- "PDF" / "printable" / "send to a client" -> `pdf`
- "Word" / "editable document" -> `docx`
- "Excel" / "sheet" / "table" / "data" -> `xlsx` (or `csv` when they want a plain data file)
- "webpage" -> `html`; "plain text" -> `txt`; "for another program" -> `json`
Run `node "WORKBENCH\scripts\convert-doc.mjs" --formats` if you need the current list.

## Convert
```
node "WORKBENCH\scripts\convert-doc.mjs" "<input>" --to <format> [--out "<path>"] [--title "<title>"]
```
- Default output is the input path with the new extension; pass `--out` when the user wants it elsewhere.
- Exit 0 prints `OK: wrote <path> (method=...)`. Exit 1 prints `ERROR: <reason>` — report that reason,
  do not retry blindly.
- The command is safe and read-only apart from writing the output file.

## Report back
Give the user the absolute output path, the format, and (for PDF) which method produced it.
Mention the size in KB. Keep it to two lines.

## Rules
- **Arabic (or any non-Latin) + PDF**: the built-in writer cannot draw those glyphs. `auto` already
  prefers headless Edge/Chrome, which handles them. If no browser exists on the machine, say so and
  offer `docx`/`html` instead of shipping a PDF full of `?`.
- Markdown tables become real tables in pdf/docx/html and real rows in xlsx/csv — prefer a table in the
  source document when the user wants a sheet.
- Never overwrite the input file; if the target path equals the source, pass a different `--out`.
- Do not add npm packages for document generation. The converter is Node builtins only, by design.
