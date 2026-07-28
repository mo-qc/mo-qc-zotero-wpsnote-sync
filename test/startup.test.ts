import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    if (
      typeof Zotero === "undefined" ||
      !(Zotero as any)[config.addonInstance]
    ) {
      this.skip();
    }
    assert.isNotEmpty((Zotero as any)[config.addonInstance]);
  });
});
