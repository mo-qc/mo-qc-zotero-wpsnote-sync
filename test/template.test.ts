import { expect } from "chai";
import { renderItemTemplate } from "../src/utils/template";
import { buildNoteXml } from "../src/utils/xmlBuilder";
import type { ZoteroItemData } from "../src/utils/xmlBuilder";

function makeItem(overrides: Partial<ZoteroItemData> = {}): ZoteroItemData {
    return {
        key: "TESTKEY",
        title: "Example Title",
        itemType: "journalArticle",
        creators: ["Alice", "Bob"],
        date: "2025-07-27",
        year: "2025",
        abstract: "This is the abstract.",
        url: "https://example.com",
        DOI: "10.1000/example",
        publicationTitle: "Journal of Examples",
        tags: ["tag1", "tag2"],
        notes: [],
        attachments: [],
        annotations: [],
        citeKey: "example2025",
        ...overrides,
    };
}

describe("renderItemTemplate", function () {
    it("renders simple variables", function () {
        const item = makeItem();
        const result = renderItemTemplate("{{title}}", item);
        expect(result).to.equal("Example Title");
    });

    it("escapes XML by default", function () {
        const item = makeItem({ title: "<script>alert(1)</script>" });
        const result = renderItemTemplate("{{title}}", item);
        expect(result).to.equal("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("outputs raw XML with triple braces", function () {
        const item = makeItem({ title: "<b>bold</b>" });
        const result = renderItemTemplate("{{{title}}}", item);
        expect(result).to.equal("<b>bold</b>");
    });

    it("supports if blocks", function () {
        const item = makeItem({ abstract: "Some abstract" });
        const result = renderItemTemplate(
            "{{#if hasAbstract}}Yes{{else}}No{{/if}}",
            item,
        );
        expect(result).to.equal("Yes");
    });

    it("supports unless blocks", function () {
        const item = makeItem({ abstract: "" });
        const result = renderItemTemplate(
            "{{#unless hasAbstract}}Missing{{/unless}}",
            item,
        );
        expect(result).to.equal("Missing");
    });

    it("supports each blocks", function () {
        const item = makeItem({ tags: ["a", "b"] });
        const result = renderItemTemplate("{{#each tags}}{{.}} {{/each}}", item);
        expect(result.trim()).to.equal("a b");
    });

    it("renders the default body template without throwing", function () {
        const item = makeItem();
        const result = buildNoteXml(item);
        expect(result).to.include("Example Title");
    });

    it("supports hyphenated variable names", function () {
        const item = makeItem({
            // @ts-expect-error - testing custom hyphenated field
            "custom-field": "custom-value",
        });
        const result = renderItemTemplate("{{custom-field}}", item);
        expect(result).to.equal("custom-value");
    });
});
