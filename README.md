# Zotero → WPS/Craft Notes Sync

[![zotero target version](https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

A Zotero 7+ plugin (verified on Zotero 10) that syncs literature items, notes, PDF links, and annotations to **WPS Notes** via the WPS MCP (Model Context Protocol) endpoint, with controlled two-way sync back into Zotero.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Features

- **Manual & auto sync**: Sync selected items from the right-click menu, or auto-sync when a configurable tag is added.
- **Rich content**: Syncs metadata, abstract, attachments, PDF annotations, child notes, and tags.
- **Markdown support**: Annotations and notes are converted to WPS-compatible XML, including bold, italic, links, tables, nested lists (with `listLevel`), checklists, fenced code blocks (with language), blockquotes, inline/block LaTeX, and inline code.
- **Local images**: Local attachment images are embedded as base64 data URIs when syncing notes; pulling a note back from WPS fetches image blocks via `read_image` and writes them as data URIs.
- **Incremental sync**: Skips unchanged items by tracking Zotero modification times.
- **Conflict resolution**: Prompts to overwrite, skip, or create a copy when a synced item has changed.
- **Deduplication**: Updates existing WPS notes via a local item-key → note-id mapping, with mapping-failure detection and rebuild.
- **Sync history**: View the last sync status, WPS Note ID, and any errors.
- **Cancellable progress**: The sync progress window can be closed to cancel the operation.
- **Collection sync**: Sync an entire collection/folder at once.
- **Customizable templates**: Uses a Mustache-like template engine for note title and body, with preset templates and a live preview rendered from the currently selected item.
- **Controlled two-way sync**: A background poller detects WPS-side edits (by `update_time` baseline) and asks before pulling them back; manual "Pull from WPS" writes the note into Zotero as a child note, reusing the same child on repeated pulls (no duplicates).
- **Trash-aware mapping**: If a synced note is deleted in WPS (moved to trash), the mapping and the redundant `ZWS-Note-Id` in the item's `extra` field are cleared and a fresh note is created on the next sync.
- **Mapping self-healing**: The WPS note id is mirrored into the item's `extra` field, so the mapping survives storage wipes.
- **MCP config validation**: A "Validate" button checks pasted MCP JSON (format + structure) and performs a real connection test before you save.
- **Rich semantic output**: Content is rendered with WPS-native blocks (highlight blocks, columns, tables, quotes, code blocks) rather than flattened text.
- **Auto-sync triggers**: Sync by tag, or automatically re-sync an item a few seconds after its metadata/annotations/child notes change (child-note edits from AI tools are picked up too).
- **Concurrency control**: Batch sync runs with a configurable worker count to stay within WPS rate limits.
- **MCP Server endpoint**: The plugin serves a local MCP endpoint at `http://127.0.0.1:23119/wpsnote/mcp` (Streamable HTTP) so external AI clients (Claude, llm-for-zotero, ...) can read sync status, poll WPS changes, and — when explicitly enabled in preferences — trigger sync/pull. Write tools are off by default; an optional access token can be required.
- **AI chat-driven sync**: Registers `wps_sync_status`, `wps_poll_changes`, `wps_sync_item`, and `wps_pull_note` as agent tools in llm-for-zotero, so you can ask your AI to sync or pull items conversationally (write actions require an in-chat confirmation card).
- **Better Notes link conversion**: Child notes containing Better Notes `zotero://note/u/<KEY>/` links are rewritten to the target note's WPS URL; unmapped or dead links degrade to plain text.

## Requirements

- Zotero 7+ (developed and verified on Zotero 10)
- Node.js LTS
- A WPS Notes MCP API Key (cloud or local streamable_http endpoint)

## Quick Start

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and set the path to your Zotero binary and profile.

   ```sh
   cp .env.example .env
   ```

3. Start the development server:

   ```sh
   npm start
   ```

   This will build the plugin, launch Zotero, and watch files for hot reload.

4. In Zotero, open the plugin preferences and enter your **WPS MCP API Key** and endpoint.

5. Select one or more items and choose **"Sync to WPS Notes"** from the right-click menu.

## Build

```sh
npm run build
```

The built XPI will be in `.scaffold/build/`.

## Test

```sh
npm run test:unit
```

## Configuration

Open **Edit → Preferences → Zotero → WPS/Craft Notes Sync** in Zotero.

| Preference            | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| MCP Endpoint          | WPS MCP endpoint, e.g. `https://ainote.kdocs.cn/mcp-svc/mcp`        |
| API Key               | Your WPS MCP API key                                                |
| Interface             | Cloud MCP or local streamable_http                                  |
| Default Tags          | Tags to add to every synced note                                    |
| Update existing notes | Update existing WPS notes instead of creating duplicates            |
| Incremental sync      | Skip items that have not changed since last sync                    |
| Prompt on conflict    | Ask how to handle changed items                                     |
| Sync content switches | Include abstract, attachments, annotations, tags, child notes       |
| Auto-sync tag         | Automatically sync items when this tag is added                     |
| Auto-sync on modify   | Re-sync an item a few seconds after metadata/annotation edits       |
| Sync concurrency      | Parallel workers for batch sync (recommended 1–5)                   |
| WPS change poller     | Periodically check synced notes for WPS-side edits and prompt       |
| MCP Server write      | Allow external MCP clients to call sync/pull tools (off by default) |
| MCP Server token      | Optional access token required from MCP clients                     |
| Title/Body templates  | Customize output using the template syntax below                    |

### Template Syntax

Variables are wrapped in double braces, raw XML in triple braces:

```text
{{title}}
{{{abstractParagraph}}}
```

Conditionals:

```text
{{#if hasAbstract}}
<h2>Abstract</h2>
{{{abstractParagraph}}}
{{/if}}
```

Loops:

```text
{{#each attachments}}
<p>{{title}}</p>
{{/each}}
```

Common variables include `title`, `authors`, `yearOrDate`, `publicationTitle`, `itemType`, `DOI`, `url`, `citeKey`, `itemKey`, `abstractParagraph`, `doiLink`, `urlLink`, `hasAnnotations`, `annotationGroupsByColor`, `hasNotes`, `contentParagraph`, and `hasTags`.

## Project Structure

```text
.
├── addon/              # Static plugin assets (manifest, bootstrap, UI, locales)
├── src/                # TypeScript source
│   ├── modules/        # Business modules (sync engine, MCP client, UI, etc.)
│   └── utils/          # Shared utilities (template engine, XML helpers, prefs)
├── test/               # Unit tests
├── typings/            # TypeScript declarations
└── zotero-plugin.config.ts
```

## Acknowledgments

This plugin is built on top of the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) by [windingwind](https://github.com/windingwind) and uses the following open-source projects:

- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
- [zotero-types](https://github.com/windingwind/zotero-types)

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0+). See [LICENSE](./LICENSE) for the full text.
