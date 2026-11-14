/**
 * WPS 语义 XML → Craft Markdown 转换器。
 * 模板生态（标题/正文模板、变量、预设）保持单一来源，仅在输出层分叉：
 * WPS 走语义 XML，Craft 走标准 Markdown + Craft 扩展（<callout> 等）。
 */

const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "hr",
  "table",
  "highlightblock",
  "columns",
  "column",
  "codeblock",
  "htmlblock",
  "ul",
  "ol",
  "li",
  "pre",
  "div",
  "section",
  "article",
]);

function escapeMdText(text: string): string {
  // 表格单元格内需要转义管道符与换行
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function inlineWalk(node: Node | null, keepNL = false): string {
  if (!node) return "";
  if (node.nodeType === 3) {
    // blockquote 等多行内联场景需保留换行（Craft quote 按行渲染），
    // 其余场景压平为单行空格
    return keepNL
      ? (node.nodeValue || "").replace(/\r/g, "").replace(/[ \t]+/g, " ")
      : (node.nodeValue || "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const kids = (): string =>
    Array.from(el.childNodes)
      .map((n) => inlineWalk(n, keepNL))
      .join("");

  switch (tag) {
    case "strong":
    case "b":
      return `**${kids()}**`;
    case "em":
    case "i":
      return `*${kids()}*`;
    case "s":
    case "del":
    case "strike":
      return `~~${kids()}~~`;
    case "u":
      return `<u>${kids()}</u>`;
    case "code": {
      const t = kids();
      return t.includes("`") ? ` \`\`${t}\`\` ` : `\`${t}\``;
    }
    case "a": {
      const href = el.getAttribute("href") || "";
      const text = kids();
      if (!href || href.startsWith("javascript:")) return text;
      return `[${text || href}](${href})`;
    }
    case "br":
      return "\n";
    case "img": {
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "图片";
      return /^https?:\/\//i.test(src) ? `![${alt}](${src})` : `🖼 ${alt}`;
    }
    case "latex": {
      const f = el.getAttribute("formula") || kids();
      return f ? `$${f}$` : "";
    }
    case "emoji":
      return el.getAttribute("name") || kids() || "🙂";
    case "ainote":
    case "cloudfile": {
      const name = el.getAttribute("name") || kids() || "链接";
      const url = el.getAttribute("url") || el.getAttribute("href") || "";
      return url ? `[${name}](${url})` : name;
    }
    case "span":
    case "font": {
      const text = kids();
      const hl = (
        el.getAttribute("fontHighlightColor") ||
        el.getAttribute("highlightColor") ||
        ""
      ).trim();
      // 颜色值白名单校验，防模板注入非法属性值
      if (hl && text.trim() && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/.test(hl)) {
        // Craft 规则：highlight 只能相邻不能嵌套，span 内首尾空格保留在标签外
        const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const lead = m?.[1] || "";
        const core = m?.[2] || "";
        const trail = m?.[3] || "";
        if (core)
          return `${lead}<highlight color="${hl}">${core}</highlight>${trail}`;
      }
      // Craft 不支持行内文字色，fontColor 翻译为 caption 灰字
      // （模板侧 WPS 用 fontColor 表达灰字，此处做双端语义翻译）
      const fc = (el.getAttribute("fontColor") || "").trim();
      if (fc && text.trim()) return `<caption>${text}</caption>`;
      return text;
    }
    case "caption":
      return `<caption>${kids()}</caption>`;
    case "tag": {
      // Craft 子标签只支持两级（官方"轻量层级"示例均为 #parent/child，
      // 3+ 级在 Craft UI 不渲染为标签）。Zotero 层级标签适配：
      // 1-2 级原样；3+ 级保留父级、其余段用连字符压平（信息不丢、可按父级聚合）
      const raw = kids().replace(/^#/, "").trim();
      if (!raw) return "";
      const segs = raw
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!segs.length) return "";
      const craftTag =
        segs.length <= 2
          ? segs.join("/")
          : `${segs[0]}/${segs.slice(1).join("-")}`;
      // 尾随空格：相邻 <tag> 元素间需要分隔，否则 #a#b 粘连成一个坏标签
      return `#${craftTag.replace(/\s+/g, "-")} `;
    }
    default:
      return kids();
  }
}

function tableToMarkdown(el: Element): string {
  const rows = Array.from(el.querySelectorAll("tr")) as HTMLTableRowElement[];
  if (!rows.length) return "";
  const lines: string[] = [];
  rows.forEach((tr, idx) => {
    const cells = (Array.from(tr.children) as HTMLElement[])
      .filter((c) => ["td", "th"].includes(c.tagName.toLowerCase()))
      .map((c) => escapeMdText(inlineWalk(c).trim()));
    if (!cells.length) return;
    lines.push(`| ${cells.join(" | ")} |`);
    if (idx === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  });
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

/** 列表递归渲染：每层缩进 2 空格（Craft 规则 2 leading spaces = 1 级） */
function renderList(
  items: Element[],
  ordered: boolean,
  depth: number,
  out: string[],
): void {
  const indent = "  ".repeat(depth);
  items.forEach((li, idx) => {
    const marker = ordered ? `${idx + 1}.` : "-";
    const inlineParts: string[] = [];
    const nested: string[] = [];
    Array.from(li.childNodes).forEach((c) => {
      if (!c) return;
      if (c.nodeType === 1) {
        const t = (c as Element).tagName.toLowerCase();
        if (t === "ul" || t === "ol") {
          const subItems = Array.from((c as Element).children).filter(
            (s) => s.tagName.toLowerCase() === "li",
          ) as Element[];
          renderList(subItems, t === "ol", depth + 1, nested);
          return;
        }
      }
      inlineParts.push(inlineWalk(c));
    });
    const text = inlineParts.join("").replace(/\s+/g, " ").trim();
    if (text) out.push(`${indent}${marker} ${text}\n`);
    out.push(...nested);
  });
}

function blockWalk(node: Node | null, out: string[]): void {
  if (!node) return;
  if (node.nodeType === 3) {
    const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
    if (text) out.push(`${text}\n\n`);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]);
      // h2 及以下章节前加轻分隔线（对齐 Craft 原生文档的分区节奏），文档开头不加
      if (level >= 2 && out.some((s) => s.trim().length > 0)) {
        out.push("***\n\n");
      }
      out.push(`${"#".repeat(level)} ${inlineWalk(el).trim()}\n\n`);
      return;
    }
    case "p": {
      // WPS 原生列表（p listType/listLevel）→ Markdown 列表，
      // 每 2 空格一级缩进（Craft 嵌套规则），否则嵌套层级会丢失
      const listType = (el.getAttribute("listType") || "").toLowerCase();
      if (listType) {
        const t = inlineWalk(el).trim();
        if (!t) return;
        const level = Math.max(
          0,
          Math.min(Number(el.getAttribute("listLevel")) || 0, 9),
        );
        const indent = "  ".repeat(level);
        if (listType === "ordered") {
          out.push(`${indent}1. ${t}\n`);
        } else if (listType === "todo") {
          const checked = el.getAttribute("checked") === "1";
          out.push(`${indent}- [${checked ? "x" : " "}] ${t}\n`);
        } else {
          out.push(`${indent}- ${t}\n`);
        }
        return;
      }
      const t = inlineWalk(el).trim();
      if (t) out.push(`${t}\n\n`);
      return;
    }
    case "blockquote": {
      const inner = inlineWalk(el, true).trim();
      if (inner) {
        out.push(
          `${inner
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")}\n\n`,
        );
      }
      return;
    }
    case "hr":
      out.push("---\n\n");
      return;
    case "table":
      out.push(tableToMarkdown(el));
      return;
    case "highlightblock": {
      const emoji = el.getAttribute("emoji") || "";
      // 颜色由 callout 底色/边框承载（highlightBlockBackgroundColor/BorderColor），
      // 内容行不再套行内 highlight：新模板下第一个 <p> 可能是标签行，
      // 旧行内上色逻辑会把 #tag 误包成高亮块
      const body: string[] = [];
      Array.from(el.childNodes).forEach((c) => {
        if (c) blockWalk(c, body);
      });
      const inner = body
        .join("")
        .replace(/\n{2,}/g, "\n")
        .trim();
      if (inner) {
        out.push(
          `<callout>\n${emoji ? `${emoji} ` : ""}${inner}</callout>\n\n`,
        );
      }
      return;
    }
    case "codeblock": {
      const t = (el.textContent || "").replace(/\n+$/, "");
      // 保留语言标记（WPS <codeblock lang> ↔ Craft ```lang）
      const lang = (el.getAttribute("lang") || "")
        .replace(/[^a-zA-Z0-9+#._-]/g, "")
        .toLowerCase();
      out.push(`\`\`\`${lang}\n${t}\n\`\`\`\n\n`);
      return;
    }
    case "htmlblock": {
      const t = (el.textContent || "").trim();
      if (t) out.push(`${t}\n\n`);
      return;
    }
    case "columns": {
      // Craft 无分栏：≥2 列且列内均为段落时合并为 2 列表格（元数据区更紧凑），
      // 含标题/表格等复杂块或单列时回退顺序平铺
      const cols = Array.from(el.children).filter(
        (c) => c.tagName.toLowerCase() === "column",
      ) as Element[];
      if (cols.length >= 2) {
        const colCells: string[][] = [];
        let fallback = false;
        for (const col of cols) {
          const cells: string[] = [];
          Array.from(col.childNodes).forEach((c) => {
            if (!c) return;
            if (c.nodeType === 3) {
              const t = (c.nodeValue || "").replace(/\s+/g, " ").trim();
              if (t) cells.push(escapeMdText(t));
              return;
            }
            if (c.nodeType !== 1) return;
            const t = (c as Element).tagName.toLowerCase();
            if (t === "p") {
              const p = inlineWalk(c as Element).trim();
              if (p) cells.push(escapeMdText(p));
            } else if (t !== "br") {
              fallback = true;
            }
          });
          colCells.push(cells);
        }
        const rows = Math.max(0, ...colCells.map((c) => c.length));
        if (!fallback && rows > 0) {
          // 元数据区用引用块（Craft 原生优雅风格：多行单块），
          // 替代无表头表格（首行数据会被 Craft 当表头渲染，观感差）
          const lines: string[] = [];
          for (const col of colCells) {
            for (const cell of col) lines.push(cell);
          }
          out.push(`> ${lines.join("\n")}\n\n`);
          return;
        }
      }
      Array.from(el.childNodes).forEach((c) => blockWalk(c, out));
      return;
    }
    case "column":
    case "div":
    case "section":
    case "article":
    case "pre": {
      // 孤立列/容器：顺序降级输出
      Array.from(el.childNodes).forEach((c) => blockWalk(c, out));
      return;
    }
    case "ul":
    case "ol": {
      const items = Array.from(el.children).filter(
        (c) => c.tagName.toLowerCase() === "li",
      ) as Element[];
      renderList(items, tag === "ol", 0, out);
      out.push("\n");
      return;
    }
    case "li": {
      out.push(`- ${inlineWalk(el).trim()}\n`);
      return;
    }
    default: {
      if (BLOCK_TAGS.has(tag)) {
        const t = inlineWalk(el).trim();
        if (t) out.push(`${t}\n\n`);
      } else {
        // 行内或未知标签：按行内处理，避免丢内容
        const t = inlineWalk(el).trim();
        if (t) out.push(`${t}\n\n`);
      }
    }
  }
}

/** 将 buildNoteXml 产出的语义 XML 片段转换为 Craft Markdown */
export function wpsXmlToCraftMarkdown(xml: string): string {
  if (!xml || !xml.trim()) return "";
  const wrapped = `<zws-root>${xml}</zws-root>`;
  const parser = new DOMParser();
  const doc = parser.parseFromString(wrapped, "text/html");
  const root = doc.querySelector("zws-root") || (doc.body as Element | null);
  if (!root) return "";
  const out: string[] = [];
  Array.from(root.childNodes).forEach((c) => blockWalk(c, out));
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============ Craft Markdown → Zotero note HTML（pullFromCraft 回流用） ============
// 覆盖本插件自身生成的 markdown 语法子集 + Craft 手写常见语法

function mdInlineToHtml(s: string): string {
  let t = s;
  // 受信 HTML 标签 → Zotero note 等价标签（先替换，避免后续裸 < 转义误伤）
  t = t.replace(
    /<highlight color="([^"]*)">([\s\S]*?)<\/highlight>/gi,
    (_m, c: string, inner: string) =>
      /^#[0-9a-fA-F]{3,8}$/.test(c)
        ? `<span style="background-color:${c}">${inner}</span>`
        : inner,
  );
  t = t.replace(
    /<caption>([\s\S]*?)<\/caption>/gi,
    (_m, inner: string) => `<span style="color:#808080">${inner}</span>`,
  );
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, src: string) =>
      `<img src="${src.replace(/"/g, "&quot;")}" alt="${alt.replace(/"/g, "&quot;")}">`,
  );
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, txt: string, href: string) =>
      `<a href="${href.replace(/"/g, "&quot;")}">${txt}</a>`,
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  t = t.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 裸 & / < 转义（放行已生成与 Zotero 支持的标签）
  t = t.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
  t = t.replace(
    /<(?!(?:\/?(?:strong|b|em|i|s|strike|u|code|a|img|span|hr|br|highlight|caption)\b))/g,
    "&lt;",
  );
  return t;
}

function isMdSpecialLine(l: string): boolean {
  return (
    /^(#{1,6})\s+/.test(l) ||
    /^```/.test(l) ||
    /^>\s?/.test(l) ||
    /^\|.*\|\s*$/.test(l) ||
    /^<callout>/i.test(l.trim()) ||
    /^(?:---+|\*{3,})\s*$/.test(l) ||
    /^(\s*)([-*]|\d+\.)\s+/.test(l)
  );
}

function parseMdList(
  lines: string[],
  start: number,
): { html: string; next: number } {
  const m0 = lines[start]?.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (!m0) return { html: "", next: start + 1 };
  const baseIndent = m0[1].length;
  const ordered = /\d/.test(m0[2]);
  let idx = start;
  let html = ordered ? "<ol>" : "<ul>";
  while (idx < lines.length) {
    const m = lines[idx].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!m || m[1].length !== baseIndent) break;
    let content = m[3];
    let j = idx + 1;
    // 深缩进的续行并入当前项；普通段落行不吞（留给外层）
    const deeper = " ".repeat(baseIndent + 2);
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      lines[j].startsWith(deeper) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[j]) &&
      !isMdSpecialLine(lines[j])
    ) {
      content += " " + lines[j].trim();
      j++;
    }
    // 子列表（缩进更深的列表行）递归
    const subStart = j;
    while (
      j < lines.length &&
      /^(\s*)([-*]|\d+\.)\s+/.test(lines[j]) &&
      (lines[j].match(/^(\s*)/) as RegExpMatchArray)[1].length > baseIndent
    ) {
      j++;
    }
    let inner = mdInlineToHtml(content);
    if (j > subStart) {
      inner += parseMdList(lines.slice(subStart, j), 0).html;
    }
    html += `<li>${inner}</li>`;
    idx = j;
  }
  html += ordered ? "</ol>" : "</ul>";
  return { html, next: idx };
}

/** 将 Craft Markdown（本插件生成或 Craft 手写）转换为 Zotero note HTML */
export function craftMarkdownToZoteroHtml(md: string): string {
  if (!md || !md.trim()) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // 代码块
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      const esc = buf.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      out.push(`<pre><code>${esc}</code></pre>`);
      continue;
    }

    // callout（单行/多行）→ blockquote
    if (/^<callout>/i.test(line.trim())) {
      const buf: string[] = [];
      const rest = line.trim().replace(/^<callout>\s*/i, "");
      let closed = false;
      if (/<\/callout>\s*$/i.test(rest)) {
        buf.push(rest.replace(/<\/callout>\s*$/i, ""));
        closed = true;
      } else if (rest) {
        buf.push(rest);
      }
      i++;
      while (!closed && i < lines.length) {
        if (/<\/callout>/i.test(lines[i])) {
          buf.push(lines[i].replace(/<\/callout>\s*$/i, ""));
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      const parts = buf
        .join("\n")
        .trim()
        .split(/\n{2,}/)
        .map((p) => p.replace(/\n/g, " ").trim())
        .filter(Boolean)
        .map((p) => `<p>${mdInlineToHtml(p)}</p>`)
        .join("");
      out.push(`<blockquote>${parts}</blockquote>`);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${mdInlineToHtml(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^---+\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 表格（首行 |…| + 分隔行）
    if (/^\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        const raw = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "");
        rows.push(raw.split("|").map((c) => c.trim().replace(/\\\|/g, "|")));
        i++;
      }
      const hasSep =
        rows.length >= 2 &&
        rows[1].every((c) => c === "" || /^:?-{2,}:?$/.test(c));
      const header = hasSep ? rows[0] : null;
      const body = hasSep ? rows.slice(2) : rows;
      let t = "<table>";
      if (header) {
        t += `<thead><tr>${header
          .map((c) => `<th>${mdInlineToHtml(c)}</th>`)
          .join("")}</tr></thead>`;
      }
      t += `<tbody>${body
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${mdInlineToHtml(c)}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table>`;
      out.push(t);
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const inner = buf.join(" ").trim();
      if (inner)
        out.push(`<blockquote><p>${mdInlineToHtml(inner)}</p></blockquote>`);
      continue;
    }

    // 列表
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const r = parseMdList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 段落：收集连续非特殊行
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isMdSpecialLine(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${mdInlineToHtml(buf.map((b) => b.trim()).join(" "))}</p>`);
  }

  return out.join("");
}
