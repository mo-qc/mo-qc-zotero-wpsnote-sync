import { expect } from "chai";
import { runWithConcurrency } from "../src/utils/concurrencyHelper";

describe("runWithConcurrency", function () {
  it("processes all items and preserves order", async function () {
    const items = ["a", "b", "c"];
    const results = await runWithConcurrency(items, async (item, index) => {
      return `${item}${index}`;
    });
    expect(results).to.deep.equal(["a0", "b1", "c2"]);
  });

  it("returns empty array for empty input", async function () {
    const results = await runWithConcurrency([], async () => "x");
    expect(results).to.deep.equal([]);
  });

  it("respects concurrency limit", async function () {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4, 5];

    const results = await runWithConcurrency(
      items,
      async (item) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return item * 2;
      },
      { concurrency: 2 },
    );

    expect(results).to.deep.equal([2, 4, 6, 8, 10]);
    expect(maxRunning).to.be.at.most(2);
  });

  it("defaults to concurrency of 2", async function () {
    let maxRunning = 0;
    let running = 0;
    const items = [1, 2, 3, 4];

    await runWithConcurrency(items, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });

    expect(maxRunning).to.be.at.most(2);
  });

  it("calls onProgress for each completed item", async function () {
    const items = ["x", "y", "z"];
    const progressEvents: Array<{
      completed: number;
      total: number;
      result: string;
      index: number;
      item: string;
    }> = [];

    await runWithConcurrency(items, async (item) => item.toUpperCase(), {
      concurrency: 1,
      onProgress: (completed, total, result, index, item) => {
        progressEvents.push({ completed, total, result, index, item });
      },
    });

    expect(progressEvents).to.have.lengthOf(3);
    expect(progressEvents[0]).to.deep.equal({
      completed: 1,
      total: 3,
      result: "X",
      index: 0,
      item: "x",
    });
    expect(progressEvents[2]).to.deep.equal({
      completed: 3,
      total: 3,
      result: "Z",
      index: 2,
      item: "z",
    });
  });

  it("aborts when signal is aborted", async function () {
    const controller = new AbortController();
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    const promise = runWithConcurrency(
      items,
      async (item) => {
        processed.push(item);
        if (item === 2) {
          controller.abort();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return item;
      },
      {
        concurrency: 1,
        signal: controller.signal,
        onAborted: () => processed.push(-1),
      },
    );

    await promise;
    // 只有第 1 项完成，第 2 项处理中触发 abort，后续项应被跳过
    expect(processed).to.include(-1);
    expect(processed.filter((x) => x > 0).length).to.be.at.most(2);
  });

  it("handles processor errors without stopping other workers", async function () {
    const items = [1, 2, 3];
    let caughtError = false;

    try {
      await runWithConcurrency(items, async (item) => {
        if (item === 2) {
          throw new Error("expected error");
        }
        return item * 10;
      });
    } catch (err: any) {
      caughtError = true;
      expect(err.message).to.equal("expected error");
    }

    expect(caughtError).to.be.true;
  });

  it("falls back to default concurrency for invalid values", async function () {
    let maxRunning = 0;
    let running = 0;
    const items = [1, 2, 3, 4];

    await runWithConcurrency(
      items,
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
      {
        // @ts-expect-error testing invalid value
        concurrency: "invalid",
      },
    );

    expect(maxRunning).to.be.at.most(2);
  });

  it("falls back to default concurrency for zero or negative values", async function () {
    let maxRunning = 0;
    let running = 0;
    const items = [1, 2, 3, 4];

    await runWithConcurrency(
      items,
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
      { concurrency: 0 },
    );

    expect(maxRunning).to.be.at.most(2);
  });
});
