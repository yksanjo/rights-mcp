import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "src", "server.js");

/** Drive the real server over stdio: send line-delimited JSON-RPC, collect replies by id. */
function withServer(fn) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    const pending = new Map();
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const r = pending.get(msg.id);
        if (r) { pending.delete(msg.id); r(msg); }
      }
    });
    let nextId = 1;
    const call = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    Promise.resolve(fn(call))
      .then(resolve, reject)
      .finally(() => proc.kill());
  });
}

const parseContent = (resp) => JSON.parse(resp.result.content[0].text);

test("initialize advertises tool capability", async () => {
  await withServer(async (call) => {
    const r = await call("initialize", {});
    assert.equal(r.result.serverInfo.name, "rights-mcp");
    assert.ok(r.result.capabilities.tools);
  });
});

test("tools/list returns the five licensing tools", async () => {
  await withServer(async (call) => {
    const r = await call("tools/list", {});
    const names = r.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "catalog_stats", "license_track", "quote_license", "search_tracks", "verify_license",
    ]);
  });
});

test("end-to-end over MCP: search → quote → license → verify", async () => {
  await withServer(async (call) => {
    await call("initialize", {});

    const search = parseContent(await call("tools/call", {
      name: "search_tracks", arguments: { mood: "energetic" },
    }));
    assert.ok(search.count > 0);
    const trackId = search.tracks[0].id;

    const quote = parseContent(await call("tools/call", {
      name: "quote_license", arguments: { trackId, usage: "commercial" },
    }));
    assert.ok(quote.quoteId);
    assert.ok(quote.priceUsd > 0);

    const lic = parseContent(await call("tools/call", {
      name: "license_track", arguments: { quoteId: quote.quoteId },
    }));
    assert.match(lic.licenseId, /^lic_/);
    assert.ok(lic.certificate);
    assert.ok(lic.split.platformUsd > 0);

    const verify = parseContent(await call("tools/call", {
      name: "verify_license", arguments: { certificate: lic.certificate },
    }));
    assert.equal(verify.valid, true);
    assert.equal(verify.trackId, trackId);
  });
});

test("tool errors come back as isError content, not a crash", async () => {
  await withServer(async (call) => {
    await call("initialize", {});
    const r = await call("tools/call", {
      name: "quote_license", arguments: { trackId: "does_not_exist" },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /unknown track/);
  });
});

test("unknown tool returns a JSON-RPC error", async () => {
  await withServer(async (call) => {
    const r = await call("tools/call", { name: "nope", arguments: {} });
    assert.ok(r.error);
    assert.equal(r.error.code, -32601);
  });
});
