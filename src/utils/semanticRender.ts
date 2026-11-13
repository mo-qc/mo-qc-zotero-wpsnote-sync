/**
 * 将 WPS 笔记语义 XML（模板预览输出）渲染为安全的可视化 HTML。
 * 仅支持白名单标签/属性；所有文本与属性值均转义，颜色/字号严格校验。
 * 解析失败返回 ""，由调用方回退显示源码。
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

function safeColor(v: string | null): string {
  return v && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : "";
}

function renderNode(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3) return esc(node.textContent || "");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const kids = () => Array.from(el.childNodes).map(renderNode).join("");

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `<${tag} class="rv-h">${kids()}</${tag}>`;
    case "p": {
      const lt = el.getAttribute("listType");
      if (!lt) return `<p class="rv-p">${kids()}</p>`;
      const level = parseInt(el.getAttribute("listLevel") || "0", 10) || 0;
      const pad = level * 18 + 18;
      if (lt === "bullet")
        return `<p class="rv-p rv-li" style="padding-left:${pad}px"><span class="rv-marker">•</span>${kids()}</p>`;
      if (lt === "ordered") {
        const m = el.getAttribute("listMarker") || "1.";
        return `<p class="rv-p rv-li" style="padding-left:${pad}px"><span class="rv-marker">${esc(m)}</span>${kids()}</p>`;
      }
      if (lt === "todo") {
        const checked = el.getAttribute("checked") === "1";
        return `<p class="rv-p rv-li" style="padding-left:${pad}px"><span class="rv-marker">${checked ? "☑" : "☐"}</span>${kids()}</p>`;
      }
      return `<p class="rv-p">${kids()}</p>`;
    }
    case "strong":
      return `<strong>${kids()}</strong>`;
    case "em":
      return `<em>${kids()}</em>`;
    case "s":
      return `<s>${kids()}</s>`;
    case "u":
      return `<u>${kids()}</u>`;
    case "code":
      return `<code class="rv-code">${kids()}</code>`;
    case "a": {
      const href = el.getAttribute("href") || "";
      const safe = /^(https?:|mailto:)/i.test(href) ? esc(href) : "#";
      return `<a href="${safe}" class="rv-a" title="${esc(el.getAttribute("title") || "")}">${kids()}</a>`;
    }
    case "blockquote":
      return `<blockquote class="rv-quote">${kids()}</blockquote>`;
    case "hr":
      return `<hr class="rv-hr"/>`;
    case "highlightblock": {
      const emoji = el.getAttribute("emoji") || "💡";
      const bg =
        safeColor(el.getAttribute("highlightBlockBackgroundColor")) ||
        "#FAF1E6";
      const bd =
        safeColor(el.getAttribute("highlightBlockBorderColor")) || "#FEC794";
      return `<div class="rv-hl" style="background:${bg};border-color:${bd}"><span class="rv-hl-emoji">${esc(emoji)}</span><div class="rv-hl-body">${kids()}</div></div>`;
    }
    case "span": {
      const st: string[] = [];
      const fc = safeColor(el.getAttribute("fontColor"));
      if (fc) st.push(`color:${fc}`);
      const fh = safeColor(el.getAttribute("fontHighlightColor"));
      if (fh) st.push(`background:${fh}`);
      const fs = el.getAttribute("fontSize");
      if (fs && /^\d{1,3}$/.test(fs)) st.push(`font-size:${fs}px`);
      return st.length
        ? `<span style="${st.join(";")}">${kids()}</span>`
        : kids();
    }
    case "emoji":
      return esc(el.getAttribute("value") || "");
    case "latex":
      return `<code class="rv-latex">${esc(el.getAttribute("formula") || "")}</code>`;
    case "br":
      return `<br/>`;
    case "img":
      return `<span class="rv-img">🖼 图片</span>`;
    case "table":
      return `<table class="rv-table">${kids()}</table>`;
    case "tr":
      return `<tr>${kids()}</tr>`;
    case "td":
      return `<td class="rv-td">${kids()}</td>`;
    case "columns":
      return `<div class="rv-cols">${kids()}</div>`;
    case "column":
      return `<div class="rv-col">${kids()}</div>`;
    case "codeblock":
      return `<pre class="rv-pre">${kids()}</pre>`;
    case "htmlblock":
      return `<pre class="rv-pre">［HTML 块］</pre>`;
    case "ainote":
      return `<span class="rv-ainote">📄 ${esc(el.getAttribute("name") || "笔记链接")}</span>`;
    case "cloudfile":
      return `<span class="rv-ainote">📁 ${esc(el.getAttribute("name") || "云文档")}</span>`;
    default:
      // 未知标签透明穿透，保留其子内容
      return kids();
  }
}

export function renderSemanticXml(xml: string): string {
  if (!xml.trim()) return "";
  try {
    const doc = new DOMParser().parseFromString(
      `<root>${xml}</root>`,
      "text/xml",
    );
    if (doc.getElementsByTagName("parsererror").length > 0) return "";
    const root = doc.documentElement;
    if (!root) return "";
    return Array.from(root.childNodes).map(renderNode).join("");
  } catch {
    return "";
  }
}

/**
 * 将 WPS 语义 XML 转为自包含内联样式的 HTML，
 * 用于回流写入 Zotero 子笔记（子笔记不加载插件 CSS，必须内联）。
 */
function convertNode(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3) return esc(node.textContent || "");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const kids = () => Array.from(el.childNodes).map(convertNode).join("");

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const size = {
        h1: "1.55",
        h2: "1.3",
        h3: "1.15",
        h4: "1.05",
        h5: "1",
        h6: "0.95",
      }[tag];
      return `<${tag} style="font-size:${size}em;margin:14px 0 6px;line-height:1.35;">${kids()}</${tag}>`;
    }
    case "p": {
      const base = "margin:6px 0;line-height:1.65;";
      const lt = el.getAttribute("listType");
      if (!lt) return `<p style="${base}">${kids()}</p>`;
      const level = parseInt(el.getAttribute("listLevel") || "0", 10) || 0;
      const pad = level * 18 + 18;
      let marker = "•";
      if (lt === "ordered") marker = esc(el.getAttribute("listMarker") || "1.");
      else if (lt === "todo")
        marker = el.getAttribute("checked") === "1" ? "☑" : "☐";
      return `<p style="${base}padding-left:${pad}px;"><span style="margin-right:6px;">${marker}</span>${kids()}</p>`;
    }
    case "strong":
      return `<strong>${kids()}</strong>`;
    case "em":
      return `<em>${kids()}</em>`;
    case "s":
      return `<s>${kids()}</s>`;
    case "u":
      return `<u>${kids()}</u>`;
    case "code":
      return `<code style="background:#f4f4f5;padding:1px 5px;border-radius:3px;font-size:0.92em;">${kids()}</code>`;
    case "a": {
      const href = el.getAttribute("href") || "";
      const safe = /^(https?:|mailto:)/i.test(href) ? esc(href) : "#";
      return `<a href="${safe}" style="color:#2b6cb0;">${kids()}</a>`;
    }
    case "blockquote":
      return `<blockquote style="border-left:3px solid #d0d7de;margin:8px 0;padding:2px 0 2px 12px;color:#57606a;">${kids()}</blockquote>`;
    case "hr":
      return `<hr style="border:none;border-top:1px solid #d0d7de;margin:12px 0;"/>`;
    case "highlightblock": {
      const emoji = el.getAttribute("emoji") || "💡";
      const bg =
        safeColor(el.getAttribute("highlightBlockBackgroundColor")) ||
        "#FAF1E6";
      const bd =
        safeColor(el.getAttribute("highlightBlockBorderColor")) || "#FEC794";
      return `<div style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:10px 14px;margin:10px 0;"><span style="margin-right:6px;">${esc(emoji)}</span>${kids()}</div>`;
    }
    case "span": {
      const st: string[] = [];
      const fc = safeColor(el.getAttribute("fontColor"));
      if (fc) st.push(`color:${fc}`);
      const fh = safeColor(el.getAttribute("fontHighlightColor"));
      if (fh) st.push(`background:${fh}`);
      const fs = el.getAttribute("fontSize");
      if (fs && /^\d{1,3}$/.test(fs)) st.push(`font-size:${fs}px`);
      return st.length
        ? `<span style="${st.join(";")}">${kids()}</span>`
        : kids();
    }
    case "emoji":
      return esc(el.getAttribute("value") || "");
    case "latex":
      return `<code style="background:#f4f4f5;padding:1px 5px;border-radius:3px;">${esc(el.getAttribute("formula") || "")}</code>`;
    case "br":
      return `<br/>`;
    case "img": {
      const src = el.getAttribute("src") || "";
      const safe = /^(https?:|data:image\/)/i.test(src) ? esc(src) : "";
      const alt = esc(el.getAttribute("alt") || "图片");
      return safe
        ? `<img src="${safe}" alt="${alt}" style="max-width:100%;"/>`
        : `<span>🖼 ${alt}</span>`;
    }
    case "table":
      return `<table style="border-collapse:collapse;margin:8px 0;">${kids()}</table>`;
    case "tr":
      return `<tr>${kids()}</tr>`;
    case "td":
    case "th":
      return `<${tag} style="border:1px solid #d0d7de;padding:5px 9px;vertical-align:top;">${kids()}</${tag}>`;
    case "columns":
      return `<div style="display:flex;gap:12px;">${kids()}</div>`;
    case "column":
      return `<div style="flex:1;min-width:0;">${kids()}</div>`;
    case "codeblock":
      return `<pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font-size:0.92em;margin:8px 0;">${kids()}</pre>`;
    case "htmlblock":
      return `<pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:10px 12px;white-space:pre-wrap;margin:8px 0;">［HTML 块］</pre>`;
    case "ainote":
      return `<span>📄 ${esc(el.getAttribute("name") || "笔记链接")}</span>`;
    case "cloudfile":
      return `<span>📁 ${esc(el.getAttribute("name") || "云文档")}</span>`;
    default:
      return kids();
  }
}

export function semanticXmlToZoteroHtml(xml: string): string {
  if (!xml.trim()) return "";
  try {
    const doc = new DOMParser().parseFromString(
      `<root>${xml}</root>`,
      "text/xml",
    );
    if (doc.getElementsByTagName("parsererror").length > 0) return "";
    const root = doc.documentElement;
    if (!root) return "";
    return Array.from(root.childNodes).map(convertNode).join("");
  } catch {
    return "";
  }
}
