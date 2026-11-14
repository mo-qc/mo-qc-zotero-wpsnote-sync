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

    it("converts unordered lists to native WPS list paragraphs", function () {
      const result = markdownToWpsXml("- one\n- two");
      expect(result).to.equal(
        '<p listType="bullet" listLevel="0">one</p>' +
          '<p listType="bullet" listLevel="0">two</p>',
      );
    });

    it("converts ordered lists and groups them by listId", function () {
      const result = markdownToWpsXml("1. first\n2. second");
      expect(result).to.equal(
        '<p listType="ordered" listLevel="0" listId="ol0">first</p>' +
          '<p listType="ordered" listLevel="0" listId="ol0">second</p>',
      );
    });

    it("preserves list nesting via listLevel", function () {
      const result = markdownToWpsXml("- a\n  - a1\n    - a2\n- b");
      expect(result).to.equal(
        '<p listType="bullet" listLevel="0">a</p>' +
          '<p listType="bullet" listLevel="1">a1</p>' +
          '<p listType="bullet" listLevel="2">a2</p>' +
          '<p listType="bullet" listLevel="0">b</p>',
      );
    });

    it("starts a new ordered group when nesting level changes", function () {
      const result = markdownToWpsXml("1. a\n  1. a1\n1. b");
      expect(result).to.equal(
        '<p listType="ordered" listLevel="0" listId="ol0">a</p>' +
          '<p listType="ordered" listLevel="1" listId="ol1">a1</p>' +
          '<p listType="ordered" listLevel="0" listId="ol2">b</p>',
      );
    });

    it("converts nested checklists to todo list paragraphs", function () {
      const result = markdownToWpsXml("- [x] done\n  - [ ] sub");
      expect(result).to.equal(
        '<p listType="todo" listLevel="0" checked="1">done</p>' +
          '<p listType="todo" listLevel="1" checked="0">sub</p>',
      );
    });

    it("converts fenced code blocks with language", function () {
      const result = markdownToWpsXml("```python\nprint(1)\n```");
      expect(result).to.equal('<codeblock lang="python">print(1)</codeblock>');
    });

    it("wraps code blocks containing XML special chars in CDATA", function () {
      const result = markdownToWpsXml("```xml\n<a> & <b>\n```");
      expect(result).to.equal(
        '<codeblock lang="xml"><![CDATA[<a> & <b>]]></codeblock>',
      );
    });

    it("splits CDATA terminator inside code blocks", function () {
      const result = markdownToWpsXml("```\na]]>b\n```");
      expect(result).to.equal(
        "<codeblock><![CDATA[a]]]]><![CDATA[>b]]></codeblock>",
      );
    });

    it("keeps unclosed code fence content as code", function () {
      const result = markdownToWpsXml("```js\nconst a = 1;");
      expect(result).to.equal('<codeblock lang="js">const a = 1;</codeblock>');
    });

    it("converts blockquote with line breaks", function () {
      const result = markdownToWpsXml("> first\n> second");
      expect(result).to.equal("<blockquote>first<br/>second</blockquote>");
    });

    it("converts checklists", function () {
      const result = markdownToWpsXml("- [x] done\n- [ ] todo");
      expect(result).to.equal(
        '<p listType="todo" listLevel="0" checked="1">done</p>' +
          '<p listType="todo" listLevel="0" checked="0">todo</p>',
      );
    });

    it("converts block LaTeX", function () {
      const result = markdownToWpsXml("$$E = mc^2$$");
      expect(result).to.equal('<p><latex formula="E = mc^2"/></p>');
    });

    it("converts inline LaTeX", function () {
      const result = markdownToWpsXml("energy $E = mc^2$ equation");
      expect(result).to.equal(
        '<p>energy <latex formula="E = mc^2"/> equation</p>',
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
