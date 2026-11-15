import { config } from "../../package.json";
import { buildNoteTitle, buildNoteXml } from "../utils/xmlBuilder";
import type { ZoteroItemData } from "../utils/xmlBuilder";
import {
  getMcpConfig,
  parseMcpConfigJson,
  getApiKey,
  setApiKey,
  getLocalMcpToken,
  setLocalMcpToken,
  getCraftApiToken,
  setCraftApiToken,
  getCraftConfig,
  setPref,
  getAutoSyncLibraryIds,
} from "../utils/prefs";
import { WpsMcpClient } from "./wpsMcpClient";
import { CraftClient } from "./craftClient";
import { restartChangePoller } from "./changePoller";
import { renderSemanticXml } from "../utils/semanticRender";
import { extractItemData } from "./zoteroItem";
import { TEMPLATE_PRESETS } from "../utils/template";

/** 预览数据源：真实选中文献（优先）或 null（回退示例） */
let previewData: { data: ZoteroItemData; label: string } | null = null;

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = {
    window: _window,
  };
  bindPrefEvents();
  await loadSelectedForPreview();
}

/** 取主窗口当前选中的首条文献作为预览数据源；无选中则回退示例数据 */
async function loadSelectedForPreview(): Promise<void> {
  try {
    const win =
      Zotero.getMainWindow() ||
      (Zotero.getMainWindows()[0] as _ZoteroTypes.MainWindow | undefined);
    const pane = (win as any)?.ZoteroPane;
    const selected: Zotero.Item[] = pane?.getSelectedItems?.() || [];
    const item = selected.find((it) => !it.isNote?.() && !it.isAttachment?.());
    if (!item) {
      previewData = null;
    } else {
      previewData = {
        data: extractItemData(item),
        label: `真实文献：${String(item.getField("title") || item.key).slice(0, 40)}`,
      };
    }
  } catch (e: any) {
    ztoolkit.log("loadSelectedForPreview failed, fallback to example", e);
    previewData = null;
  }
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

/** 库类型展示名（设置页文献库多选） */
const LIBRARY_TYPE_LABELS: Record<string, string> = {
  user: "个人库",
  group: "群组库",
  feed: "订阅",
};
/**
 * 动态生成"同步的文献库"多选列表。
 * 未配置时按默认状态展示（订阅不勾、其余勾）；用户任一勾选变化即
 * 落盘显式白名单，此后严格按所选库同步。
 */
function buildLibraryList(doc: Document) {
  const container = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-libraryList`,
  );
  if (!container) return;
  container.replaceChildren();

  let libs: Array<{ libraryID: number; libraryType: string; name: string }> =
    [];
  try {
    libs = (Zotero.Libraries.getAll() as any[]).filter(
      (l) =>
        l.visible !== false &&
        (l.libraryType === "user" ||
          l.libraryType === "group" ||
          l.libraryType === "feed"),
    );
  } catch (e) {
    ztoolkit.log("buildLibraryList: Libraries.getAll failed", e);
  }

  const configured = getAutoSyncLibraryIds();

  for (const lib of libs) {
    const checked = configured
      ? configured.includes(lib.libraryID)
      : lib.libraryType !== "feed";

    const row = doc.createElement("label");
    row.className = "zws-checkbox-row";
    row.style.marginBottom = "6px";

    const input = doc.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.id = `zotero-prefpane-${config.addonRef}-lib-${lib.libraryID}`;
    input.dataset.libraryid = String(lib.libraryID);

    const lbl = doc.createElement("label");
    lbl.htmlFor = input.id;
    lbl.textContent = `${lib.name}（${LIBRARY_TYPE_LABELS[lib.libraryType] || lib.libraryType}）`;

    input.addEventListener("change", () => {
      const ids = Array.from(container.querySelectorAll("input[type=checkbox]"))
        .map((el) => el as HTMLInputElement)
        .filter((el) => el.checked)
        .map((el) => Number(el.dataset.libraryid))
        .filter((n) => Number.isFinite(n) && n > 0);
      setPref("autoSyncLibraries", JSON.stringify(ids));
    });

    row.append(input, lbl);
    container.append(row);
  }
}

function bindPrefEvents() {
  const doc = addon.data.prefs?.window.document;
  if (!doc) return;

  // 横版 tab 切换：按 data-tab / data-panel 显隐面板
  doc.querySelector(".zws-tab-bar")?.addEventListener("click", (ev: Event) => {
    const btn = (ev.target as Element).closest?.(
      ".zws-tab",
    ) as HTMLElement | null;
    if (!btn?.dataset.tab) return;
    const tab = btn.dataset.tab;
    doc
      .querySelectorAll(".zws-tab")
      .forEach((t: Element) => t.classList.toggle("active", t === btn));
    doc.querySelectorAll(".zws-tab-panel").forEach((p: Element) => {
      const panel = p as HTMLElement;
      panel.classList.toggle("active", panel.dataset.panel === tab);
    });
  });

  buildLibraryList(doc);

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
  // macOS 原生 menulist 选完可能只发 command 不发 change，两个都听
  const mcpInterfaceSelect = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpInterfaceType`,
  ) as HTMLElement | null;
  const mcpAuthInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpAuth`,
  ) as HTMLInputElement | null;
  const mcpTestBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpTestBtn`,
  ) as HTMLButtonElement | null;
  const mcpTestResult = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpTestResult`,
  ) as HTMLSpanElement | null;

  const refresh = () => refreshTemplatePreview();

  titleInput?.addEventListener("input", refresh);
  bodyInput?.addEventListener("input", refresh);

  // 用主窗口当前选中文献刷新预览数据源
  doc
    .getElementById(`zotero-prefpane-${config.addonRef}-previewRefreshBtn`)
    ?.addEventListener("click", () => {
      loadSelectedForPreview();
    });

  // 模板预设：填充模板框并持久化
  doc
    .getElementById(`zotero-prefpane-${config.addonRef}-presetBar`)
    ?.addEventListener("click", (ev: Event) => {
      const btn = (ev.target as HTMLElement | null)?.closest(
        "[data-preset]",
      ) as HTMLElement | null;
      const preset = TEMPLATE_PRESETS.find(
        (p) => p.id === btn?.getAttribute("data-preset"),
      );
      if (!preset || !titleInput || !bodyInput) return;
      titleInput.value = preset.titleTemplate;
      bodyInput.value = preset.bodyTemplate;
      setPref("titleTemplate", preset.titleTemplate);
      setPref("bodyTemplate", preset.bodyTemplate);
      refresh();
    });

  // 变量 chips：点击在正文模板光标处插入 {{var}}
  const chips = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-varChips`,
  );
  chips?.addEventListener("click", (ev: Event) => {
    const target = (ev.target as HTMLElement | null)?.closest(
      ".zws-chip",
    ) as HTMLElement | null;
    if (!target || !bodyInput) return;
    const variable = target.getAttribute("data-var");
    if (!variable) return;
    const snippet = `{{${variable}}}`;
    const start = bodyInput.selectionStart ?? bodyInput.value.length;
    const end = bodyInput.selectionEnd ?? start;
    bodyInput.value =
      bodyInput.value.slice(0, start) + snippet + bodyInput.value.slice(end);
    const pos = start + snippet.length;
    bodyInput.setSelectionRange(pos, pos);
    bodyInput.focus();
    bodyInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 预览视图切换：渲染预览 / 源码
  const viewSwitch = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-viewSwitch`,
  );
  const bodyPreviewEl = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyPreview`,
  ) as HTMLTextAreaElement | null;
  const renderEl = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyPreviewRender`,
  ) as HTMLDivElement | null;
  viewSwitch?.addEventListener("click", (ev: Event) => {
    const btn = (ev.target as HTMLElement | null)?.closest(
      ".zws-view-btn",
    ) as HTMLElement | null;
    if (!btn) return;
    const view = btn.getAttribute("data-view");
    viewSwitch
      .querySelectorAll(".zws-view-btn")
      .forEach((b: Element) => b.classList.toggle("active", b === btn));
    bodyPreviewEl?.classList.toggle("zws-hidden", view !== "source");
    renderEl?.classList.toggle("zws-hidden", view !== "render");
  });

  // MCP 简单配置：接口类型 + 单密钥输入
  // menulist 与 select 都暴露 value 属性（XUL menulist 的 value = 选中项 value）
  const currentInterface = (): "cloud" | "local" =>
    (mcpInterfaceSelect as unknown as { value?: string } | null)?.value ===
    "local"
      ? "local"
      : "cloud";
  const loadAuthValue = () => {
    if (!mcpAuthInput) return;
    mcpAuthInput.value =
      currentInterface() === "local" ? getLocalMcpToken() : getApiKey();
  };
  const refreshMcpStatus = () => {
    if (mcpConfigInput && mcpConfigStatus) {
      updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    }
  };
  loadAuthValue();
  refreshMcpStatus();
  // preference 属性回填 textarea 是异步的，回填后再刷一次状态
  setTimeout(refreshMcpStatus, 200);

  const onInterfaceChange = () => {
    loadAuthValue();
    refreshMcpStatus();
  };
  mcpInterfaceSelect?.addEventListener("change", onInterfaceChange);
  mcpInterfaceSelect?.addEventListener("command", onInterfaceChange);
  // 改动轮询开关变更后立即重启轮询（关→开即时生效）
  doc
    .getElementById(`zotero-prefpane-${config.addonRef}-changePollEnabled`)
    ?.addEventListener("change", () => restartChangePoller());
  // 打字即防抖保存：change 要等失焦才触发，期间切换接口/重开设置页会用
  // pref 旧值覆盖未保存的输入（用户看到"输入的 key 变成了别的"）
  let authSaveTimer: ReturnType<typeof setTimeout> | undefined;
  mcpAuthInput?.addEventListener("input", () => {
    if (authSaveTimer) clearTimeout(authSaveTimer);
    authSaveTimer = setTimeout(() => {
      const value = mcpAuthInput.value.trim();
      if (currentInterface() === "local") {
        setLocalMcpToken(value);
      } else {
        setApiKey(value);
      }
    }, 300);
  });
  mcpAuthInput?.addEventListener("change", () => {
    if (authSaveTimer) clearTimeout(authSaveTimer);
    const value = mcpAuthInput.value.trim();
    if (currentInterface() === "local") {
      setLocalMcpToken(value);
    } else {
      setApiKey(value);
    }
    // 简单配置接管：清空已粘贴的 JSON，避免旧 JSON 静默覆盖新密钥
    if (mcpConfigInput && mcpConfigInput.value.trim()) {
      mcpConfigInput.value = "";
    }
    setPref("mcpConfigJson", "");
    refreshMcpStatus();
  });

  // MCP JSON 配置实时校验与状态提示
  if (mcpConfigInput && mcpConfigStatus) {
    mcpConfigInput.addEventListener("input", () => {
      updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    });
    mcpConfigInput.addEventListener("change", () => {
      updateMcpConfigStatus(mcpConfigInput, mcpConfigStatus);
    });
  }

  // 验证配置：解析 JSON（或回退简单配置）后实际连接 MCP 端点
  if (mcpTestBtn && mcpTestResult) {
    const btnLabel = mcpTestBtn.textContent || "验证配置";
    mcpTestBtn.addEventListener("click", async () => {
      // 先落盘输入框当前值：change 可能尚未触发，否则验证的是 pref 旧值
      const authVal = mcpAuthInput?.value.trim() || "";
      if (authVal) {
        if (currentInterface() === "local") {
          setLocalMcpToken(authVal);
        } else {
          setApiKey(authVal);
        }
      }
      const json = mcpConfigInput?.value.trim() || "";
      const parsed = json ? parseMcpConfigJson(json) : getMcpConfig();
      if (!parsed || !parsed.apiKey) {
        mcpTestResult.className = "zws-mcp-test-result error";
        mcpTestResult.textContent = json
          ? "JSON 无法解析：请检查是否包含 mcpServers 与 url/headers。"
          : "当前无可用配置：请粘贴 JSON 或在上方填写密钥。";
        return;
      }
      mcpTestBtn.disabled = true;
      mcpTestBtn.textContent = "测试中…";
      mcpTestResult.className = "zws-mcp-test-result pending";
      mcpTestResult.textContent = `正在连接 ${parsed.endpoint} …`;
      try {
        const client = new WpsMcpClient({
          ...parsed,
          timeout: 15000,
          retries: 0,
        });
        await client.initialize();
        mcpTestResult.className = "zws-mcp-test-result ok";
        mcpTestResult.textContent = `连接成功：${
          parsed.interfaceType === "local" ? "本地" : "云端"
        } MCP（${parsed.endpoint}）`;
      } catch (e: any) {
        mcpTestResult.className = "zws-mcp-test-result error";
        mcpTestResult.textContent = `连接失败：${e?.message || String(e)}`;
      } finally {
        mcpTestBtn.disabled = false;
        mcpTestBtn.textContent = btnLabel;
      }
    });
  }

  // Craft 连接：token 加密存储（打字防抖 + change 双保险）+ 连接测试
  const craftTokenInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-craftApiToken`,
  ) as HTMLInputElement | null;
  const craftTestBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-craftTestBtn`,
  ) as HTMLButtonElement | null;
  const craftTestResult = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-craftTestResult`,
  ) as HTMLSpanElement | null;
  if (craftTokenInput) {
    craftTokenInput.value = getCraftApiToken();
    let craftSaveTimer: ReturnType<typeof setTimeout> | undefined;
    const saveCraftToken = () => {
      const v = craftTokenInput.value.trim();
      if (v !== getCraftApiToken()) setCraftApiToken(v);
    };
    craftTokenInput.addEventListener("input", () => {
      if (craftSaveTimer) clearTimeout(craftSaveTimer);
      craftSaveTimer = setTimeout(saveCraftToken, 300);
    });
    craftTokenInput.addEventListener("change", () => {
      if (craftSaveTimer) clearTimeout(craftSaveTimer);
      saveCraftToken();
    });
  }
  if (craftTestBtn && craftTestResult) {
    const craftBtnLabel = craftTestBtn.textContent || "测试连接";
    craftTestBtn.addEventListener("click", async () => {
      const v = craftTokenInput?.value.trim() || "";
      if (v && v !== getCraftApiToken()) setCraftApiToken(v);
      const cfg = getCraftConfig();
      if (!cfg.link || !cfg.token) {
        craftTestResult.className = "zws-mcp-test-result error";
        craftTestResult.textContent = "请先填写 API Link 与 Token。";
        return;
      }
      craftTestBtn.disabled = true;
      craftTestBtn.textContent = "测试中…";
      craftTestResult.className = "zws-mcp-test-result pending";
      craftTestResult.textContent = "正在连接 Craft…";
      try {
        const client = new CraftClient({
          link: cfg.link,
          token: cfg.token,
          timeoutMs: 15000,
        });
        const info = await client.connection();
        craftTestResult.className = "zws-mcp-test-result ok";
        craftTestResult.textContent = `连接成功：${
          info.space?.name || info.space?.id || "已连接"
        }`;
      } catch (e) {
        craftTestResult.className = "zws-mcp-test-result error";
        craftTestResult.textContent = `连接失败：${
          e instanceof Error ? e.message : String(e)
        }`;
      } finally {
        craftTestBtn.disabled = false;
        craftTestBtn.textContent = craftBtnLabel;
      }
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
    if (config.apiKey) {
      status.className = "zws-mcp-status ok";
      status.textContent = `使用简单配置：${
        config.interfaceType === "local" ? "本地" : "云端"
      } MCP（${config.endpoint}），密钥已设置。`;
    } else {
      status.className = "zws-mcp-status fallback";
      status.textContent = "未配置密钥，请在上方填写 API Key / Authorization。";
    }
    return;
  }

  const parsed = parseMcpConfigJson(value);
  if (parsed) {
    status.className = "zws-mcp-status ok";
    status.textContent = `JSON 配置有效（优先于简单配置）：已识别为${
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
  const bodyPreviewRender = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-bodyPreviewRender`,
  ) as HTMLDivElement | null;

  if (!titlePreview || !bodyPreview) return;

  const source = previewData;
  const example = source ? source.data : createExampleItem();
  const sourceLabel = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-previewSourceLabel`,
  );
  if (sourceLabel) {
    sourceLabel.textContent = source
      ? source.label
      : "示例数据（在 Zotero 中选中文献可切换为真实预览）";
  }
  try {
    titlePreview.value = buildNoteTitle(example, titleInput?.value || "");
  } catch (e: any) {
    titlePreview.value = `标题渲染错误：${e?.message || String(e)}`;
  }

  let xml = "";
  try {
    xml = buildNoteXml(example, bodyInput?.value || "");
    bodyPreview.value = xml;
  } catch (e: any) {
    bodyPreview.value = `正文渲染错误：${e?.message || String(e)}`;
  }

  if (bodyPreviewRender) {
    const html = xml ? renderSemanticXml(xml) : "";
    if (html) {
      // XUL 文档内元素直接赋 innerHTML 会被剥掉标签，经游离元素中转再移动子节点
      const tmp = doc.createElement("div");
      tmp.innerHTML = html;
      const nodes = Array.from(tmp.childNodes).filter(
        (n): n is Node => n !== null,
      );
      bodyPreviewRender.replaceChildren(...nodes);
    } else {
      bodyPreviewRender.textContent =
        "预览渲染失败（输出不是合法 XML），请切换到「源码」查看。";
    }
  }
}
