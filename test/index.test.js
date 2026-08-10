const { describe, it } = require("node:test");
const assert = require("node:assert");

const plugin = require("../lib/index.js");

describe("koishi-plugin-hub-pusl", () => {
  it("should export plugin name", () => {
    assert.strictEqual(plugin.name, "hub-pusl");
  });

  it("should export apply function", () => {
    assert.strictEqual(typeof plugin.apply, "function");
  });

  it("should export Config schema", () => {
    assert.ok(plugin.Config);
  });
});
