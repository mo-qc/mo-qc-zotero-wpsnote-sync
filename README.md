# Zotero → WPS Notes Sync

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

A Zotero 7 plugin that syncs literature items, notes, PDF links, and annotations to **WPS Notes** via the WPS MCP (Model Context Protocol) endpoint.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Features

- **Manual & auto sync**: Sync selected items from the right-click menu, or auto-sync when a configurable tag is added.
- **Rich content**: Syncs metadata, abstract, attachments, PDF annotations, child notes, and tags.
- **Markdown support**: Annotations and notes are converted to WPS-compatible XML, including bold, italic, links, tables, lists, checklists, inline/block LaTeX, and inline code.
- **Local images**: Local attachment images are embedded as base64 data URIs when syncing notes.
- **Incremental sync**: Skips unchanged items by tracking Zotero modification times.
- **Conflict resolution**: Prompts to overwrite, skip, or create a copy when a synced item has changed.
- **Deduplication**: Updates existing WPS notes via a local item-key → note-id mapping, with mapping-failure detection and rebuild.
- **Sync history**: View the last sync status, WPS Note ID, and any errors.
- **Cancellable progress**: The sync progress window can be closed to cancel the operation.
- **Collection sync**: Sync an entire collection/folder at once.
- **Customizable templates**: Uses a Mustache-like template engine for note title and body.

## Requirements

- Zotero 7
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

Open **Edit → Preferences → Zotero → WPS Notes Sync** in Zotero.

| Preference            | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| MCP Endpoint          | WPS MCP endpoint, e.g. `https://ainote.kdocs.cn/mcp-svc/mcp`  |
| API Key               | Your WPS MCP API key                                          |
| Interface             | Cloud MCP or local streamable_http                            |
| Default Tags          | Tags to add to every synced note                              |
| Update existing notes | Update existing WPS notes instead of creating duplicates      |
| Incremental sync      | Skip items that have not changed since last sync              |
| Prompt on conflict    | Ask how to handle changed items                               |
| Sync content switches | Include abstract, attachments, annotations, tags, child notes |
| Auto-sync tag         | Automatically sync items when this tag is added               |
| Title/Body templates  | Customize output using the template syntax below              |

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
