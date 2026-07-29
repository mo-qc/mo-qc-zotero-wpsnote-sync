import { expect } from "chai";
import { parseMcpConfigJson } from "../src/utils/prefs";

describe("parseMcpConfigJson", function () {
  it("parses local streamable_http config with Authorization Bearer", function () {
    const json = JSON.stringify({
      mcpServers: {
        wpsnote: {
          transport: "streamable_http",
          url: "http://127.0.0.1:18930/mcp",
          headers: {
            Authorization: "Bearer note_baa400f334cefa06bcfa907167a64ce0",
            API_KEY: "note_baa400f334cefa06bcfa907167a64ce0",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.interfaceType).to.equal("local");
    expect(config!.endpoint).to.equal("http://127.0.0.1:18930/mcp");
    expect(config!.apiKey).to.equal("note_baa400f334cefa06bcfa907167a64ce0");
  });

  it("parses cloud config with X-API-Key", function () {
    const json = JSON.stringify({
      mcpServers: {
        "wps-note-cloud": {
          url: "https://ainote.kdocs.cn/mcp-svc/mcp",
          headers: {
            "X-API-Key":
              "33a3ed28c2e1b1c24bec9b2a17878c9f362bad8130e63a687c208fb0f4f952c9",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.interfaceType).to.equal("cloud");
    expect(config!.endpoint).to.equal("https://ainote.kdocs.cn/mcp-svc/mcp");
    expect(config!.apiKey).to.equal(
      "33a3ed28c2e1b1c24bec9b2a17878c9f362bad8130e63a687c208fb0f4f952c9",
    );
  });

  it("returns null for empty input", function () {
    expect(parseMcpConfigJson("")).to.be.null;
    expect(parseMcpConfigJson("   ")).to.be.null;
  });

  it("returns null for invalid JSON", function () {
    expect(parseMcpConfigJson("not json")).to.be.null;
  });

  it("returns null when required fields are missing", function () {
    expect(parseMcpConfigJson(JSON.stringify({}))).to.be.null;
    expect(
      parseMcpConfigJson(JSON.stringify({ mcpServers: { wps: {} } })),
    ).to.be.null;
  });

  it("falls back to API_KEY header without Authorization", function () {
    const json = JSON.stringify({
      mcpServers: {
        wpsnote: {
          url: "http://127.0.0.1:18930/mcp",
          headers: {
            API_KEY: "note_abc123",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.interfaceType).to.equal("local");
    expect(config!.apiKey).to.equal("note_abc123");
  });

  it("supports mcp_server alias", function () {
    const json = JSON.stringify({
      mcp_server: {
        wpsnote: {
          url: "http://127.0.0.1:18930/mcp",
          headers: {
            API_KEY: "note_alias",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.apiKey).to.equal("note_alias");
  });
});
