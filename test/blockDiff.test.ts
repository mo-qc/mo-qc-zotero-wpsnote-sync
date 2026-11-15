import { expect } from "chai";
import {
  splitTopLevelBlocks,
  buildDiffPlan,
  normalizeBlockMd,
} from "../src/utils/blockDiff";

describe("blockDiff", function () {
  describe("blockDiff.splitTopLevelBlocks", function () {
    it("splits paragraphs on blank lines", function () {
      const out = splitTopLevelBlocks("第一段\n\n第二段\n\n# 标题");
      expect(out).to.deep.equal(["第一段", "第二段", "# 标题"]);
    });

    it("keeps callout with internal blank lines as one block", function () {
      const md = "<callout>📋 摘要\n\n多段内容</callout>\n\n下一段";
      expect(splitTopLevelBlocks(md)).to.deep.equal([
        "<callout>📋 摘要\n\n多段内容</callout>",
        "下一段",
      ]);
    });

    it("keeps fenced code with internal blank lines as one block", function () {
      const md = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n之后";
      expect(splitTopLevelBlocks(md)).to.deep.equal([
        "```js\nconst a = 1;\n\nconst b = 2;\n```",
        "之后",
      ]);
    });

    it("keeps pipe table (single newlines) as one block", function () {
      const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n尾段";
      expect(splitTopLevelBlocks(md)).to.deep.equal([
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
        "尾段",
      ]);
    });

    it("keeps consecutive blockquote lines as one block", function () {
      const md = "> 行一\n> 行二\n\n正文";
      expect(splitTopLevelBlocks(md)).to.deep.equal(["> 行一\n> 行二", "正文"]);
    });

    it("divider lines become their own blocks", function () {
      const md = "上\n\n---\n\n下";
      expect(splitTopLevelBlocks(md)).to.deep.equal(["上", "---", "下"]);
    });
  });

  describe("blockDiff.normalizeBlockMd", function () {
    it("unifies --- to *** and trims", function () {
      expect(normalizeBlockMd("  ---  ")).to.equal("***");
      expect(normalizeBlockMd("***")).to.equal("***");
    });
  });

  describe("blockDiff.buildDiffPlan", function () {
    const remote = (mds: string[]) =>
      mds.map((markdown, i) => ({ id: `r${i}`, markdown }));

    it("identical sequences → empty plan", function () {
      const plan = buildDiffPlan(remote(["A", "B", "C"]), ["A", "B", "C"]);
      expect(plan).to.not.equal(null);
      expect(plan!.puts).to.deep.equal([]);
      expect(plan!.deletes).to.deep.equal([]);
      expect(plan!.inserts).to.deep.equal([]);
    });

    it("changed content → PUT preserving id", function () {
      const plan = buildDiffPlan(remote(["A", "B", "C"]), ["A", "B2", "C"]);
      expect(plan!.puts).to.deep.equal([{ id: "r1", markdown: "B2" }]);
      expect(plan!.deletes).to.deep.equal([]);
      expect(plan!.inserts).to.deep.equal([]);
    });

    it("removed remote block → delete", function () {
      const plan = buildDiffPlan(remote(["A", "B", "C"]), ["A", "C"]);
      expect(plan!.deletes).to.deep.equal(["r1"]);
      expect(plan!.puts).to.deep.equal([]);
    });

    it("new rendered block → insert before next kept anchor", function () {
      const plan = buildDiffPlan(remote(["A", "C"]), ["A", "B", "C"]);
      expect(plan!.inserts).to.deep.equal([{ markdown: "B", anchorId: "r1" }]);
      expect(plan!.deletes).to.deep.equal([]);
      expect(plan!.puts).to.deep.equal([]);
    });

    it("appended tail → insert with null anchor (caller uses marker)", function () {
      const plan = buildDiffPlan(remote(["A"]), ["A", "B", "C"]);
      expect(plan!.inserts).to.deep.equal([
        { markdown: "B", anchorId: null },
        { markdown: "C", anchorId: null },
      ]);
    });

    it("mixed change: put + delete + insert", function () {
      const plan = buildDiffPlan(remote(["A", "B", "C", "D"]), [
        "A",
        "Bx",
        "D",
        "E",
      ]);
      expect(plan!.puts).to.deep.equal([{ id: "r1", markdown: "Bx" }]);
      expect(plan!.deletes).to.deep.equal(["r2"]); // C 多余
      expect(plan!.inserts).to.deep.equal([{ markdown: "E", anchorId: null }]);
    });

    it("normalization: --- vs *** counts as equal", function () {
      const plan = buildDiffPlan(remote(["---"]), ["***"]);
      expect(plan!.puts).to.deep.equal([]);
      expect(plan!.deletes).to.deep.equal([]);
      expect(plan!.inserts).to.deep.equal([]);
    });

    it("low match ratio → null (fallback to full replace)", function () {
      const plan = buildDiffPlan(
        remote(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]),
        ["x", "y", "z", "w", "v", "u", "t", "s", "r", "q"],
      );
      expect(plan).to.equal(null);
    });

    it("put with internal blank lines demotes to delete+insert (PUT requires single block)", function () {
      const plan = buildDiffPlan(remote(["A", "B", "C"]), [
        "A",
        "X1\n\nX2",
        "C",
      ]);
      expect(plan!.puts).to.deep.equal([]);
      expect(plan!.deletes).to.deep.equal(["r1"]);
      // 锚点 = 后继保留块 r2
      expect(plan!.inserts).to.deep.equal([
        { markdown: "X1\n\nX2", anchorId: "r2" },
      ]);
    });

    it("demoted tail block uses null anchor", function () {
      const plan = buildDiffPlan(remote(["A", "B"]), ["A", "Y1\n\nY2"]);
      expect(plan!.deletes).to.deep.equal(["r1"]);
      expect(plan!.inserts).to.deep.equal([
        { markdown: "Y1\n\nY2", anchorId: null },
      ]);
    });

    it("empty rendered → delete all", function () {
      const plan = buildDiffPlan(remote(["A", "B"]), []);
      expect(plan!.deletes).to.deep.equal(["r0", "r1"]);
    });
  });
});
