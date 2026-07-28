/**
 * 轻量级 Markdown → WPS 笔记 XML 转换器。
 * 覆盖批注/笔记中常见场景：段落、粗体、斜体、行内代码、链接、表格、列表、LaTeX 公式。
 */

import { escapeXml, link } from "./xmlHelpers";

const PLACEHOLDER = "\x00";

function inlineMarkdownToXml(text: string): string {
  if (!text) return "";
  const placeholders: string[] = [];
  let result = text;

  // 行内 LaTeX 公式：\(...\) 和 $...$
  result = result.replace(/\\\((.+?)\\\)/g, (_, p1) => {
    placeholders.push(`<latex>${escapeXml(p1)}</latex>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });
  result = result.replace(/\$([^$\s].*?)\$/g, (_, p1) => {
    placeholders.push(`<latex>${escapeXml(p1)}</latex>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  // 粗体 **text** / __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_, p1) => {
    placeholders.push(`<strong>${escapeXml(p1)}</strong>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });
  result = result.replace(/__(.+?)__/g, (_, p1) => {
    placeholders.push(`<strong>${escapeXml(p1)}</strong>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  // 斜体 *text* / _text_
  result = result.replace(/\*(.+?)\*/g, (_, p1) => {
    placeholders.push(`<em>${escapeXml(p1)}</em>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });
  result = result.replace(/_(.+?)_/g, (_, p1) => {
    placeholders.push(`<em>${escapeXml(p1)}</em>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  // 链接 [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, p1, p2) => {
    placeholders.push(link(p2, p1));
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  // 行内代码 `code`
  result = result.replace(/`([^`]+)`/g, (_, p1) => {
    placeholders.push(`<code>${escapeXml(p1)}</code>`);
    return `${PLACEHOLDER}${placeholders.length - 1}${PLACEHOLDER}`;
  });

  // 转义剩余普通文本
  result = escapeXml(result);

  // 还原占位符
  result = result.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_, index) => placeholders[Number(index)],
  );

  return result;
}

function isTableDelimiter(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isChecklistItem(line: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);
}

function parseListItem(line: string): { content: string; checked?: boolean } {
  const trimmed = line.trim();
  const checklistMatch = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (checklistMatch) {
    return {
      content: checklistMatch[2],
      checked: checklistMatch[1].toLowerCase() === "x",
    };
  }
  const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
  if (bulletMatch) return { content: bulletMatch[1] };
  const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
  if (orderedMatch) return { content: orderedMatch[1] };
  return { content: trimmed };
}

function renderList(
  lines: string[],
  startIndex: number,
): { xml: string; nextIndex: number } {
  const firstLine = lines[startIndex];
  const isOrdered = isOrderedListItem(firstLine);
  const isChecklist = isChecklistItem(firstLine);
  const tag = isChecklist ? "checklist" : isOrdered ? "ol" : "ul";

  const items: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    const isList =
      isUnorderedListItem(line) ||
      isOrderedListItem(line) ||
      isChecklistItem(line);
    if (!isList) break;

    const { content, checked } = parseListItem(line);
    const inner = `<p>${inlineMarkdownToXml(content)}</p>`;
    if (isChecklist) {
      items.push(
        `<li><checkbox ${checked ? 'checked="true"' : ""}/>${inner}</li>`,
      );
    } else {
      items.push(`<li>${inner}</li>`);
    }
    i++;
  }

  return { xml: `<${tag}>${items.join("")}</${tag}>`, nextIndex: i };
}

function renderBlockLatex(
  lines: string[],
  startIndex: number,
): { xml: string; nextIndex: number } {
  const line = lines[startIndex].trim();
  // $$...$$ 单行或跨行
  if (line.startsWith("$$") && line.endsWith("$$") && line.length > 4) {
    return {
      xml: `<p><latex block="true">${escapeXml(line.slice(2, -2).trim())}</latex></p>`,
      nextIndex: startIndex + 1,
    };
  }
  // \[...\] 单行
  if (line.startsWith("\\[") && line.endsWith("\\]")) {
    return {
      xml: `<p><latex block="true">${escapeXml(line.slice(2, -2).trim())}</latex></p>`,
      nextIndex: startIndex + 1,
    };
  }
  // 跨行 $$ ... $$
  if (line === "$$") {
    const end = lines.indexOf("$$", startIndex + 1);
    if (end > startIndex) {
      const formula = lines.slice(startIndex + 1, end).join("\n");
      return {
        xml: `<p><latex block="true">${escapeXml(formula.trim())}</latex></p>`,
        nextIndex: end + 1,
      };
    }
  }
  return { xml: "", nextIndex: startIndex };
}

function parseMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((l) => !isTableDelimiter(l))
    .map((l) => {
      const cells = l.split("|");
      // Markdown 表格行以 | 开头和结尾，split 后首尾为空字符串
      return cells.slice(1, -1).map((c) => c.trim());
    });

  if (rows.length === 0) return "";

  const xmlRows = rows
    .map((row) => {
      const cells = row
        .map((cell) => `<td><p>${inlineMarkdownToXml(cell)}</p></td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table>${xmlRows}</table>`;
}

/**
 * 将 Markdown 拆分为：表格前文本、表格 XML、表格后文本。
 * 当前处理单张表格；多张表格时，除第一张外的表格保留在 after 文本中。
 */
export function splitMarkdownByTable(md: string): {
  before: string;
  table: string;
  after: string;
} {
  if (!md) return { before: "", table: "", after: "" };
  const lines = normalizeForXml(md).split("\n");
  let i = 0;
  let tableFound = false;
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const tableLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("|")) {
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      tableFound = true;
      continue;
    }
    if (tableFound) {
      afterLines.push(line);
    } else {
      beforeLines.push(line);
    }
    i++;
  }

  const renderLines = (ls: string[]) =>
    ls
      .filter((l) => l.trim())
      .map((l) => `<p>${inlineMarkdownToXml(l)}</p>`)
      .join("");

  return {
    before: renderLines(beforeLines),
    table: tableFound ? parseMarkdownTable(tableLines) : "",
    after: renderLines(afterLines),
  };
}

/**
 * 将 Markdown 文本转换为 WPS 笔记可识别的 XML block 序列。
 * 表格会被转换为 <table>，普通行会转为 <p>。
 */
export function markdownToWpsXml(md: string): string {
  if (!md) return "";
  const blocks: string[] = [];
  const lines = normalizeForXml(md).split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格块
    if (line.startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const tableXml = parseMarkdownTable(tableLines);
      if (tableXml) blocks.push(tableXml);
      continue;
    }

    // 列表块
    if (
      isUnorderedListItem(line) ||
      isOrderedListItem(line) ||
      isChecklistItem(line)
    ) {
      const listRes = renderList(lines, i);
      blocks.push(listRes.xml);
      i = listRes.nextIndex;
      continue;
    }

    // 块级 LaTeX 公式
    const latexRes = renderBlockLatex(lines, i);
    if (latexRes.xml) {
      blocks.push(latexRes.xml);
      i = latexRes.nextIndex;
      continue;
    }

    // 普通段落
    if (line.trim()) {
      blocks.push(`<p>${inlineMarkdownToXml(line)}</p>`);
    }
    i++;
  }

  return blocks.join("");
}

function controlCharReplacer(_ch: string): string {
  const code = _ch.charCodeAt(0);
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    return "";
  }
  return _ch;
}

function normalizeForXml(text: string): string {
  return text
    .replace(/[\s\S]/g, controlCharReplacer)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
