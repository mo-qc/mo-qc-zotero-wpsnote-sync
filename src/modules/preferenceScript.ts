import { config } from "../../package.json";
import { buildNoteTitle, buildNoteXml } from "../utils/xmlBuilder";
import type { ZoteroItemData } from "../utils/xmlBuilder";
import { getApiKey, setApiKey } from "../utils/prefs";

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = {
    window: _window,
  };
  bindPrefEvents();
  refreshTemplatePreview();
}

function createExampleItem(): ZoteroItemData {
  return {
    key: "EXAMPLE123",
    title: "Example Paper Title: Zotero → WPS Notes Sync via MCP",
    itemType: "journalArticle",
    creators: ["Alice Zhang", "Bob Li"],
    date: "2025-07-27",
    year: "2025",
    abstract:
      "This is a sample abstract. The template engine supports variable substitution, conditionals, and loops, allowing you to customize the format synced to WPS Notes.",
    url: "https://example.com/paper",
    DOI: "10.1000/example",
    publicationTitle: "Journal of Examples",
    tags: ["Zotero", "WPS", "Sync"],
    notes: [
      {
        title: "Reading Notes",
        content:
          '<p>This is a sample note.</p><p>Notes may also include images like <img src="https://example.com/image.png" alt="Example image" />.</p>',
        images: [
          {
            src: "https://example.com/image.png",
            alt: "Example image",
          },
        ],
      },
    ],
    attachments: [
      {
        key: "ATTACH123",
        title: "Example Paper.pdf",
        contentType: "application/pdf",
        isPDF: true,
      },
    ],
    annotations: [
      {
        key: "ANNO1",
        type: "highlight",
        text: "This is an example highlight annotation text.",
        comment: "This is a comment on the highlight.",
        color: "#ffd400",
        pageLabel: "1",
        sortIndex: "00001",
        authorName: "",
        dateAdded: "2025-07-27",
        dateModified: "2025-07-27",
        tags: ["Important", "To Review"],
      },
      {
        key: "ANNO2",
        type: "note",
        text: "",
        comment: "This is a standalone note annotation.",
        color: "#5fb236",
        pageLabel: "2",
        sortIndex: "00002",
        authorName: "",
        dateAdded: "2025-07-27",
        dateModified: "2025-07-27",
        tags: [],
      },
    ],
  };
}

function bindPrefEvents() {
  const doc = addon.data.prefs?.window.document;
  if (!doc) return;

  const titleInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-titleTemplate`,
  ) as HTMLTextAreaElement | null;
  const bodyInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyTemplate`,
  ) as HTMLTextAreaElement | null;
  const apiKeyInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-wpsMcpApiKey`,
  ) as HTMLInputElement | null;

  const refresh = () => refreshTemplatePreview();

  titleInput?.addEventListener("input", refresh);
  bodyInput?.addEventListener("input", refresh);

  // API Key 需要手动读写，以便进行简单的混淆存储
  if (apiKeyInput) {
    apiKeyInput.value = getApiKey();
    apiKeyInput.addEventListener("change", () => {
      setApiKey(apiKeyInput.value);
    });
  }

  ztoolkit.log("Preference window loaded", config.addonRef);
}

function refreshTemplatePreview() {
  const doc = addon.data.prefs?.window.document;
  if (!doc) return;

  const titleInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-titleTemplate`,
  ) as HTMLTextAreaElement | null;
  const bodyInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyTemplate`,
  ) as HTMLTextAreaElement | null;
  const titlePreview = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-titlePreview`,
  ) as HTMLTextAreaElement | null;
  const bodyPreview = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyPreview`,
  ) as HTMLTextAreaElement | null;

  if (!titlePreview || !bodyPreview) return;

  const example = createExampleItem();
  try {
    titlePreview.value = buildNoteTitle(example, titleInput?.value || "");
  } catch (e: any) {
    titlePreview.value = `标题渲染错误：${e?.message || String(e)}`;
  }

  try {
    bodyPreview.value = buildNoteXml(example, bodyInput?.value || "");
  } catch (e: any) {
    bodyPreview.value = `正文渲染错误：${e?.message || String(e)}`;
  }
}
