import { expect } from "chai";
import {
  escapeXml,
  link,
  normalizeForXml,
  paragraph,
} from "../src/utils/xmlHelpers";

describe("xmlHelpers", function () {
  describe("escapeXml", function () {
    it("escapes XML special characters", function () {
      expect(escapeXml("<>&\"'")).to.equal("&lt;&gt;&amp;&quot;&apos;");
    });
  });

  describe("link", function () {
    it("creates an anchor tag with escaped attributes", function () {
      expect(link("https://example.com?a=1&b=2", "A & B")).to.equal(
        '<a href="https://example.com?a=1&amp;b=2">A &amp; B</a>',
      );
    });
  });

  describe("normalizeForXml", function () {
    it("removes control characters except tab/newline/cr", function () {
      expect(normalizeForXml("hello\x00world")).to.equal("helloworld");
      expect(normalizeForXml("a\tb")).to.equal("a\tb");
      expect(normalizeForXml("a\nb")).to.equal("a\nb");
    });

    it("normalizes line endings", function () {
      expect(normalizeForXml("a\r\nb\rc")).to.equal("a\nb\nc");
    });
  });

  describe("paragraph", function () {
    it("wraps text in paragraphs", function () {
      expect(paragraph("line1\nline2")).to.equal("<p>line1</p><p>line2</p>");
    });

    it("escapes content", function () {
      expect(paragraph("1 < 2")).to.equal("<p>1 &lt; 2</p>");
    });

    it("returns empty string for empty input", function () {
      expect(paragraph("")).to.equal("");
    });
  });
});
