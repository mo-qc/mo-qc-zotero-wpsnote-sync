pref-title = Zotero → WPS/Craft Notes Sync Settings
pref-mcpInterfaceType = Interface
pref-mcpInterfaceType-cloud =
    .label = Cloud MCP
pref-mcpInterfaceType-local =
    .label = Local MCP (Streamable HTTP)
pref-mcpAuth = API Key / Authorization
pref-mcpAuth-help = Use the X-API-Key value for cloud, or the Authorization Bearer / API_KEY value for local. Saving here takes over the JSON config below.
pref-mcpConfigJson = Advanced: Full MCP JSON (optional)
pref-mcpConfigJson-help = Optional: paste a full MCP JSON config; it takes priority over the simple settings above. Supports cloud (X-API-Key) and local (Authorization Bearer / API_KEY) formats. Leave empty to use the settings above.
pref-mcpConfigJson-status-fallback = No JSON pasted; using simple settings.
pref-mcpTest = Test Config
pref-previewRender = Rendered
pref-previewSource = Source
pref-defaultTags = Default Tags
pref-syncConcurrency = Sync Concurrency
pref-syncConcurrency-help = Number of items processed simultaneously during batch sync; 1-5 recommended, higher values may trigger WPS rate limits
pref-updateExisting = Update existing notes
pref-incrementalSync = Enable incremental sync (skip unchanged items)
pref-promptOnConflict = Prompt on conflict when item changed
pref-syncInclude-title = Sync Content
pref-syncIncludeAbstract = Abstract
pref-syncIncludeAttachments = Attachments
pref-syncIncludeAnnotations = PDF Annotations
pref-syncIncludeTags = Tags
pref-syncIncludeNotes = Notes
pref-autoSyncEnabled = Enable auto-sync by tag
pref-autoSyncOnModify = Auto-sync on modify (metadata/annotation changes trigger sync after 2s)
pref-autoSyncTag = Auto-sync tag
pref-autoSyncTag-help = Sync item to the selected targets when this tag is added; when "Auto-sync on modify" is enabled, metadata or PDF annotation changes also trigger sync
pref-autoSyncLibraries = Libraries to sync
pref-autoSyncLibraries-help = Only checked libraries participate in auto-sync; feeds (subscriptions) are excluded by default and sync only when checked
pref-titleTemplate = Note Title Template
pref-titlePreview = Title Preview
pref-bodyTemplate = Note Body Template (leave blank for default)
pref-bodyPreview = Body Preview (live)
pref-bodyTemplate-help = Syntax: double-braces variables are escaped, triple-braces output raw XML; supports if/else and each blocks. Common variables: title, authors, yearOrDate, publicationTitle, itemType, DOI, url, citeKey, itemKey, abstractParagraph, doiLink, urlLink, hasAnnotations, annotationGroupsByColor, hasNotes, contentParagraph, hasTags.
pref-changePollEnabled = Enable remote change polling reminders
pref-changePollInterval = Polling interval (minutes)
pref-changePoll-help = Periodically check whether synced notes were modified on the WPS/Craft side; when changes are found, a dialog asks whether to pull them back to Zotero. Nothing is overwritten automatically.
pref-help = Build { $version }

# MCP Server (external endpoint)
pref-mcpServerWriteEnabled = Allow external MCP clients to write (sync / pull)
pref-mcpServerToken = Access token (optional)
pref-mcpServer-help = The plugin serves an MCP endpoint at 127.0.0.1:23119/wpsnote/mcp for external AI clients (Claude, llm-for-zotero, ...) to read sync status or trigger sync. Write operations are off by default; if a token is set, clients must send Authorization: Bearer <token> or X-API-Key.

# Sync target & Craft connection
pref-syncTarget = Sync Target
pref-syncTarget-wps = WPS Notes
pref-syncTarget-craft = Craft Documents
pref-syncTarget-help = Check any combination: one sync pushes to every checked target in turn (WPS and Craft keep independent mappings and baselines); with nothing checked it falls back to WPS
pref-craftApiLink = API Link
pref-craftApiLink-help = Link generated under Craft desktop "Settings → API links", e.g. https://connect.craft.do/links/{linkId}/api/v1
pref-craftApiToken = Bearer Token
pref-craftApiToken-help = Access token shown on the same API link page; stored locally only (obfuscated)
pref-craftFolderId = Target Folder ID (optional)
pref-craftFolderId-help = New documents are created inside this folder; leave blank to create in Unsorted. Get the id from the folders list returned by the API
pref-craftTest = Test Connection

# Reading experience
pref-readingPreset = Reading Preset
pref-readingPreset-quick =
    .label = Quick (notes + annotations)
pref-readingPreset-full =
    .label = Full (default structure)
pref-readingPreset-archive =
    .label = Archive (abstract first + everything)
pref-readingPreset-help = Controls the synced note structure: Quick keeps meta/notes/annotations only; Full is the default; Archive moves the abstract to the top and keeps all sections. Applies only when the body template is blank; affects both WPS and Craft
pref-colorSemanticMap = Color Semantic Map (JSON, optional)
pref-colorSemanticMap-help = E.g. {"{"}“#7fba00”:“Key finding”,“#ff6666”:“To verify”{"}"}: maps Zotero annotation colors to semantic group titles; leave blank to use default color names. Invalid JSON is silently ignored and never blocks sync
pref-craftArchiveByTag = Auto-archive by first tag into subfolders
pref-craftArchiveByTag-help = When enabled, newly created Craft documents are placed into a subfolder named after the item's first tag (created under Target Folder if missing); existing documents are not moved, and any archiving failure falls back to the default folder without blocking sync

# Preference cards & tabs
pref-card-syncOptions = Sync Options
pref-card-autoSync = Auto Sync
pref-card-changePoll = Remote Change Alerts
pref-card-mcpConnection = MCP Connection
pref-card-craftConnection = Craft Connection
pref-card-mcpServer = MCP Server (External API)
pref-card-reading = Reading Experience
pref-card-template = Template & Preview
pref-tab-sync = Sync
pref-tab-connection = Connection
pref-tab-template = Template & Preview
pref-tab-reading = Reading
