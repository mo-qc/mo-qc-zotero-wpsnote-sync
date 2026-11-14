import { htmlToWpsXml } from "../src/utils/htmlToWps";
import { expect } from "chai";

describe("htmlToWpsXml", function () {
  it("converts tables with colspan", function () {
    const html =
      '<table><tr><td>a</td><td colspan="2">b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>';
    const result = htmlToWpsXml(html);
    expect(result).to.include("<table>");
    expect(result).to.include("<p>a</p>");
    expect(result).to.include('colspan="2"');
    expect(result).to.include("<p>e</p>");
    expect(result).to.include("</table>");
    expect(result).to.not.include("&lt;table");
    expect(result).to.not.include("<p></td>");
  });

  it("converts paragraphs with inline styles", function () {
    const html = "<p>plain <strong>bold</strong> and <em>italic</em></p>";
    expect(htmlToWpsXml(html)).to.equal(
      "<p>plain <strong>bold</strong> and <em>italic</em></p>",
    );
  });

  it("converts headings and lists", function () {
    expect(htmlToWpsXml("<h2>Title</h2>")).to.equal("<h2>Title</h2>");
    const list = htmlToWpsXml("<ul><li>one</li><li>two</li></ul>");
    expect(list).to.equal("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
  });

  it("converts links with nested text", function () {
    const html = '<p>see <a href="https://example.com">Example</a> site</p>';
    const result = htmlToWpsXml(html);
    expect(result).to.include('<a href="https://example.com">Example</a>');
    expect(result).to.include("see ");
    expect(result).to.include(" site");
  });

  it("decodes entities and re-escapes safely", function () {
    expect(htmlToWpsXml("<p>a &amp; b &lt; c&nbsp;d</p>")).to.equal(
      "<p>a &amp; b &lt; c d</p>",
    );
  });

  it("drops images (handled by separate image pipeline)", function () {
    expect(htmlToWpsXml('<p>before<img src="x.png"/>after</p>')).to.equal(
      "<p>beforeafter</p>",
    );
  });

  it("unwraps div wrappers and paragraphs bare text", function () {
    expect(htmlToWpsXml("<div>bare text</div>")).to.equal("<p>bare text</p>");
  });

  it("converts blockquote", function () {
    expect(htmlToWpsXml("<blockquote><p>quoted</p></blockquote>")).to.equal(
      "<blockquote>quoted</blockquote>",
    );
  });

  it("handles br inside paragraph", function () {
    expect(htmlToWpsXml("<p>line1<br/>line2</p>")).to.equal(
      "<p>line1<br/>line2</p>",
    );
  });

  it("converts pre/code to codeblock with language", function () {
    const html =
      '<pre><code class="language-python">print(1)\nprint(2)</code></pre>';
    expect(htmlToWpsXml(html)).to.equal(
      '<codeblock lang="python">print(1)\nprint(2)</codeblock>',
    );
  });

  it("keeps code newlines and escapes XML special chars via CDATA", function () {
    const html = '<pre><code class="language-js">if (a &lt; b) {}</code></pre>';
    expect(htmlToWpsXml(html)).to.equal(
      '<codeblock lang="js"><![CDATA[if (a < b) {}]]></codeblock>',
    );
  });

  it("converts plain pre without language", function () {
    expect(htmlToWpsXml("<pre>plain code</pre>")).to.equal(
      "<codeblock>plain code</codeblock>",
    );
  });
});
