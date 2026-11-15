import { expect } from "chai";
import { craftMarkdownToZoteroHtml } from "../src/utils/craftMarkdown";

describe("craftMarkdown", function () {
  describe("craftMarkdownToZoteroHtml (pull-back)", function () {
    it("keeps last column when trailing pipe is omitted", function () {
      const result = craftMarkdownToZoteroHtml("| a | b\n|---|---\n| 1 | 2");
      expect(result).to.include("<th>a</th>");
      expect(result).to.include("<th>b</th>");
      expect(result).to.include("<td>1</td>");
      expect(result).to.include("<td>2</td>");
    });

    it("treats escaped pipe as literal text, not a separator", function () {
      const result = craftMarkdownToZoteroHtml("| a \\| b | c |");
      expect(result).to.include("<td>a | b</td>");
      expect(result).to.include("<td>c</td>");
      expect(result).to.not.include("<td>a \\</td>");
    });

    it("converts gradient highlight (text color) to Zotero font color", function () {
      const result = craftMarkdownToZoteroHtml(
        '<highlight color="#193C47;#193C47;g">t</highlight>',
      );
      expect(result).to.include('<span style="color:#193C47">t</span>');
      expect(result).to.not.include("background-color");
    });

    it("converts solid highlight to background color", function () {
      const result = craftMarkdownToZoteroHtml(
        '<highlight color="#FF0000">t</highlight>',
      );
      expect(result).to.include(
        '<span style="background-color:#FF0000">t</span>',
      );
      expect(result).to.not.include("color:#193C47");
    });
  });
});
