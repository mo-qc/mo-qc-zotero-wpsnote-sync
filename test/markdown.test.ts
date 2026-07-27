import { expect } from "chai";
import { markdownToWpsXml, splitMarkdownByTable } from "../src/utils/markdown";

describe("markdown", function () {
  describe("markdownToWpsXml", function () {
    it("converts paragraphs", function () {
      const result = markdownToWpsXml("Hello world.");
      expect(result).to.equal("<p>Hello world.</p>");
    });

    it("converts bold and italic", function () {
      const result = markdownToWpsXml("**bold** and *italic*");
      expect(result).to.equal(
        "<p><strong>bold</strong> and <em>italic</em></p>",
      );
    });

    it("converts inline code", function () {
      const result = markdownToWpsXml("use `console.log`");
      expect(result).to.equal("<p>use <code>console.log</code></p>");
    });

    it("converts links", function () {
      const result = markdownToWpsXml("[example](https://example.com)");
      expect(result).to.equal(
        '<p><a href="https://example.com">example</a></p>',
      );
    });

    it("converts unordered lists", function () {
      const result = markdownToWpsXml("- one\n- two");
      expect(result).to.equal(
        "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
      );
    });

    it("converts ordered lists", function () {
      const result = markdownToWpsXml("1. first\n2. second");
      expect(result).to.equal(
        "<ol><li><p>first</p></li><li><p>second</p></li></ol>",
      );
    });

    it("converts checklists", function () {
      const result = markdownToWpsXml("- [x] done\n- [ ] todo");
      expect(result).to.equal(
        '<checklist><li><checkbox checked="true"/><p>done</p></li><li><checkbox /><p>todo</p></li></checklist>',
      );
    });

    it("converts block LaTeX", function () {
      const result = markdownToWpsXml("$$E = mc^2$$");
      expect(result).to.equal(
        '<p><latex block="true">E = mc^2</latex></p>',
      );
    });

    it("converts inline LaTeX", function () {
      const result = markdownToWpsXml("energy $E = mc^2$ equation");
      expect(result).to.equal(
        "<p>energy <latex>E = mc^2</latex> equation</p>",
      );
    });

    it("converts tables", function () {
      const result = markdownToWpsXml("| a | b |\n|---|---|\n| 1 | 2 |");
      expect(result).to.equal(
        "<table><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>",
      );
    });

    it("escapes XML special chars", function () {
      const result = markdownToWpsXml("1 < 2 & 2 > 0");
      expect(result).to.equal("<p>1 &lt; 2 &amp; 2 &gt; 0</p>");
    });
  });

  describe("splitMarkdownByTable", function () {
    it("splits table from surrounding text", function () {
      const result = splitMarkdownByTable("before\n| a |\n|---|\n| 1 |\nafter");
      expect(result.before).to.equal("<p>before</p>");
      expect(result.table).to.equal(
        "<table><tr><td><p>a</p></td></tr><tr><td><p>1</p></td></tr></table>",
      );
      expect(result.after).to.equal("<p>after</p>");
    });

    it("returns empty when input is empty", function () {
      const result = splitMarkdownByTable("");
      expect(result.before).to.equal("");
      expect(result.table).to.equal("");
      expect(result.after).to.equal("");
    });
  });
});
