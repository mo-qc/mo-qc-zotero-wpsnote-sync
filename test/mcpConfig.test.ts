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
            Authorization: "Bearer note_test_local_key_0123456789abcdef",
            API_KEY: "note_test_local_key_0123456789abcdef",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.interfaceType).to.equal("local");
    expect(config!.endpoint).to.equal("http://127.0.0.1:18930/mcp");
    expect(config!.apiKey).to.equal("note_test_local_key_0123456789abcdef");
  });

  it("parses cloud config with X-API-Key", function () {
    const json = JSON.stringify({
      mcpServers: {
        "wps-note-cloud": {
          url: "https://ainote.kdocs.cn/mcp-svc/mcp",
          headers: {
            "X-API-Key": "test_cloud_api_key_0123456789abcdef0123456789abcdef",
          },
        },
      },
    });
    const config = parseMcpConfigJson(json);
    expect(config).to.not.be.null;
    expect(config!.interfaceType).to.equal("cloud");
    expect(config!.endpoint).to.equal("https://ainote.kdocs.cn/mcp-svc/mcp");
    expect(config!.apiKey).to.equal(
      "test_cloud_api_key_0123456789abcdef0123456789abcdef",
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
    expect(parseMcpConfigJson(JSON.stringify({ mcpServers: { wps: {} } }))).to
      .be.null;
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
