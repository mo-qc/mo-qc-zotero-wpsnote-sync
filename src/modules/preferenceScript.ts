import { config } from "../../package.json";
import { buildNoteTitle, buildNoteXml } from "../utils/xmlBuilder";
import type { ZoteroItemData } from "../utils/xmlBuilder";
import { getMcpConfig, parseMcpConfigJson } from "../utils/prefs";

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

function getElement<T extends HTMLElement>(id: string): T | null {
  const doc = addon.data.prefs?.window.document;
  if (!doc) return null;
  return doc.getElementById(id) as T | null;
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
  const mcpConfigInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpConfigJson`,
  ) as HTMLTextAreaElement | null;
  const mcpConfigStatus = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpConfigStatus`,
  ) as HTMLParagraphElement | null;

  const refresh = () => refreshTemplatePreview();

  titleInput?.addEventListener("input", refresh);
  bodyInput?.addEventListener("input", refresh);

  // MCP JSON 配置实时校验与状态提示
  if (mcpConfigInput && mcpConfigStatus) {
    updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    mcpConfigInput.addEventListener("input", () => {
      updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    });
    mcpConfigInput.addEventListener("change", () => {
      updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    });
  }

  ztoolkit.log("Preference window loaded", config.addonRef);
}

function updateMcpConfigStatus(
  input: HTMLTextAreaElement,
  status: HTMLParagraphElement,
) {
  const value = input.value.trim();
  if (!value) {
    const config = getMcpConfig();
    status.className = "zws-mcp-status fallback";
    status.textContent = `未粘贴 JSON，当前使用旧版${
      config.interfaceType === "local" ? "本地" : "云端"
    }配置（${config.endpoint}）。`;
    return;
  }

  const parsed = parseMcpConfigJson(value);
  if (parsed) {
    status.className = "zws-mcp-status ok";
    status.textContent = `配置有效：已识别为${
      parsed.interfaceType === "local" ? "本地" : "云端"
    } MCP（${parsed.endpoint}）。`;
  } else {
    status.className = "zws-mcp-status error";
    status.textContent =
      "无法解析 MCP JSON，请检查格式是否包含 mcpServers 与 url/headers。";
  }
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
