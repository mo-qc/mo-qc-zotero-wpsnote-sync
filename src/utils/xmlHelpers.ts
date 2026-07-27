/**
 * 公共 XML/字符串处理工具，供模板引擎与 XML 构建器复用。
 */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function link(href: string, text: string): string {
  return `<a href="${escapeXml(href)}">${escapeXml(text)}</a>`;
}

function controlCharReplacer(_ch: string): string {
  // 使用回调动态判断字符码，避免在正则字面量中直接写控制字符范围。
  const code = _ch.charCodeAt(0);
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    return "";
  }
  return _ch;
}

export function normalizeForXml(text: string): string {
  return text
    .replace(/[\s\S]/g, controlCharReplacer)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function paragraph(text: string): string {
  if (!text) return "";
  const lines = normalizeForXml(text).split("\n");
  return lines.map((line) => `<p>${escapeXml(line) || "<br/>"}</p>`).join("");
}
