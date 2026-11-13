/**
 * Zotero 子笔记 HTML → WPS 笔记 XML 转换器。
 * 保留表格、标题、列表、引用、行内样式等结构；图片由独立链路插入，这里直接跳过。
 */

import { escapeXml, link } from "./xmlHelpers";
import { getMappedEntry } from "../modules/syncMapping";

const KNOWN_ENTITIES = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

/**
 * Better Notes 笔记链接（zotero://note/u/<KEY>/）→ 已同步条目的 WPS 笔记
 * URL。WPS 端会把指向自家笔记的 <a> 自动渲染为可点击的笔记链接块（ainote）。
 * 未同步/解析失败返回 null，调用方降级为纯文本（zotero:// 在 WPS 不可点）。
 */
function resolveZoteroNoteLink(
  href: string,
): { href: string; text: string } | null {
  const m = href.match(/^zotero:\/\/note\/u\/([A-Za-z0-9]{8})\/?/i);
  if (!m) return null;
  try {
    const noteItem = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      m[1],
    );
    if (!noteItem) return null;
    const parent = noteItem.parentItem;
    if (!parent) return null;
    const mapped = getMappedEntry(parent.key);
    if (mapped?.noteUrl) {
      return {
        href: mapped.noteUrl,
        text: String(parent.getField("title") || "") || mapped.noteUrl,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/gi, " ").replace(KNOWN_ENTITIES, (m, name) => {
    const lower = name.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower.startsWith("#x"))
      return String.fromCodePoint(parseInt(lower.slice(2), 16));
    return String.fromCodePoint(parseInt(lower.slice(1), 10));
  });
}

// WPS 支持的标签原样保留（转换幂等，二次处理不丢结构）；开/闭标签都要放行
const WPS_KEEP =
  /^<\/?(?:p|h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|br|strong|em|code|a|latex|highlightBlock|columns|column|emoji|codeblock|span|sub|sup)\b/i;

/**
 * 行内转换：文本统一「解码 HTML 实体 → escapeXml」，a 标签成对收集后输出。
 * a 内部的样式标签（strong/em/code）会被忽略，保证链接文本干净。
 */
function convertInline(html: string): string {
  if (!html) return "";
  const parts = html.split(/(<[^>]*>)/g);
  let out = "";
  const aStack: { href: string; text: string }[] = [];

  const sink = (s: string) => {
    if (aStack.length > 0) aStack[aStack.length - 1].text += s;
    else out += s;
  };

  for (const part of parts) {
    if (!part) continue;
    if (part[0] !== "<") {
      sink(escapeXml(decodeEntities(part)));
      continue;
    }
    const tm = part.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
    const tag = tm ? tm[1].toLowerCase() : "";
    const isClose = part.startsWith("</");

    if (isClose) {
      if (tag === "a") {
        const a = aStack.pop();
        if (a) {
          const resolved = resolveZoteroNoteLink(a.href);
          if (resolved) out += link(resolved.href, a.text || resolved.text);
          else if (a.href.startsWith("zotero://"))
            // Zotero 内部协议在 WPS 不可点，降级为纯文本
            out += a.text || "";
          else out += link(a.href, a.text || a.href);
        }
      } else if (aStack.length === 0) {
        if (tag === "strong" || tag === "b") out += "</strong>";
        else if (tag === "em" || tag === "i") out += "</em>";
        else if (tag === "code") out += "</code>";
        else if (WPS_KEEP.test(part)) out += part;
      }
      continue;
    }

    if (tag === "a") {
      const m =
        part.match(/href\s*=\s*"([^"]*)"/i) ||
        part.match(/href\s*=\s*'([^']*)'/i);
      aStack.push({ href: m ? decodeEntities(m[1]) : "", text: "" });
      continue;
    }
    if (tag === "img") continue;

    if (aStack.length > 0) continue; // a 内忽略其余行内标签

    if (tag === "br") out += "<br/>";
    else if (tag === "strong" || tag === "b") out += "<strong>";
    else if (tag === "em" || tag === "i") out += "<em>";
    else if (tag === "code") out += "<code>";
    else if (WPS_KEEP.test(part)) out += part;
  }

  while (aStack.length > 0) {
    const a = aStack.pop()!;
    const resolved = resolveZoteroNoteLink(a.href);
    if (resolved) out += link(resolved.href, a.text || resolved.text);
    else if (a.href.startsWith("zotero://")) out += a.text || "";
    else out += link(a.href, a.text || a.href);
  }
  return out;
}

function convertTable(tableHtml: string): string {
  const rows = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const outRows: string[] = [];
  for (const row of rows) {
    const cells = row.match(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/gi) || [];
    const outCells: string[] = [];
    for (const cell of cells) {
      const open = cell.match(/^<(td|th)\b([^>]*)>/i);
      const attrs = open ? open[2] : "";
      const colspan = attrs.match(/colspan\s*=\s*"?\s*(\d+)/i);
      const rowspan = attrs.match(/rowspan\s*=\s*"?\s*(\d+)/i);
      const inner = cell
        .replace(/^<[^>]+>/, "")
        .replace(/<\/[^>]+>$/, "")
        .replace(/<p\b[^>]*>/gi, "")
        .replace(/<\/p>/gi, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
      const content = convertInline(inner);
      let cellAttrs = "";
      if (colspan) cellAttrs += ` colspan="${colspan[1]}"`;
      if (rowspan) cellAttrs += ` rowspan="${rowspan[1]}"`;
      outCells.push(`<td${cellAttrs}><p>${content || "<br/>"}</p></td>`);
    }
    if (outCells.length > 0) outRows.push(`<tr>${outCells.join("")}</tr>`);
  }
  return outRows.length > 0 ? `<table>${outRows.join("")}</table>` : "";
}

export function htmlToWpsXml(html: string): string {
  if (!html) return "";
  let s = String(html);

  // 预处理：去不可见结构与图片（图片走独立插入链路）
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<img\b[^>]*>/gi, "");

  // wrapper 标签就地剥掉（保留内容），让内部块级结构裸露
  s = s.replace(
    /<\/?(?:div|section|article|aside|header|footer|nav|figure|figcaption|main|span|font)\b[^>]*>/gi,
    "",
  );

  // 标题
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, inner) => {
    const level = Math.min(Number(lv), 4);
    return `\n<h${level}>${convertInline(inner)}</h${level}>\n`;
  });

  // 段落
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => {
    const content = convertInline(inner);
    return `\n<p>${content || "<br/>"}</p>\n`;
  });

  // 表格（在段落转换之后，cell 内 p 统一压平为单段）
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => convertTable(m));

  // 引用（内部 p 转为纯内容并压平换行，保持 blockquote 单段）
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const flat = inner
      .replace(/<p\b[^>]*>/gi, "")
      .replace(/<\/p>/gi, "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    return `\n<blockquote>${convertInline(flat)}</blockquote>\n`;
  });

  // 列表项（li 内 p 转为纯内容并压平换行）
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const flat = inner
      .replace(/<p\b[^>]*>/gi, "")
      .replace(/<\/p>/gi, "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    return `<li><p>${convertInline(flat) || "<br/>"}</p></li>`;
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, b) => `\n<ul>${b}</ul>\n`);
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, b) => `\n<ol>${b}</ol>\n`);

  // 分隔线
  s = s.replace(/<hr\s*\/?>/gi, "\n<hr/>\n");

  // 残留行内样式标签剥壳；其余未知标签剥掉，WPS 标签保留
  s = s.replace(
    /<\/?(?:u|s|del|ins|mark|small|big|sub|sup|cite|q|abbr)\b[^>]*>/gi,
    "",
  );
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g, (m) =>
    WPS_KEEP.test(m) ? m : "",
  );

  // 顶层裸文本段落化
  const segments = s.split(/\n+/);
  const blocks: string[] = [];
  for (const seg of segments) {
    const t = seg.trim();
    if (!t) continue;
    if (
      /^<\/?(?:h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|p|latex|highlightBlock|columns|codeblock|emoji)\b/i.test(
        t,
      )
    ) {
      blocks.push(t);
    } else if (t.includes("<")) {
      blocks.push(`<p>${convertInline(t)}</p>`);
    } else {
      blocks.push(`<p>${escapeXml(decodeEntities(t))}</p>`);
    }
  }
  return blocks.join("\n");
}
