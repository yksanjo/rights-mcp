import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";
import { AgentWallet } from "../src/wallet.js";
import { priceFor, fromAtomic, splitRevenue } from "../src/pricing.js";

test("search ranks by relevance and exposes per-usage price", async () => {
  const app = createEngine();
  const res = await app.search({ mood: "calm", text: "lofi study" });
  assert.ok(res.length > 0);
  assert.equal(res[0].mood, "calm");
  assert.ok(res[0].estPriceUsd.commercial > res[0].estPriceUsd.creator);
  assert.ok(res[0].estPriceUsd.creator > res[0].estPriceUsd.personal);
});

test("pricing scales with usage and duration", () => {
  assert.ok(priceFor({ usage: "commercial" }) > priceFor({ usage: "creator" }));
  assert.ok(priceFor({ usage: "creator", durationSec: 600 }) > priceFor({ usage: "creator", durationSec: 60 }));
  assert.throws(() => priceFor({ usage: "nope" }));
});

test("revenue split honours take rate and conserves the total", () => {
  const s = splitRevenue(1_000_000, 1500); // $1.00, 15%
  assert.equal(s.platform, 150_000);
  assert.equal(s.rightsHolder, 850_000);
  assert.equal(s.platform + s.rightsHolder, 1_000_000);
});

test("full license loop: quote → pay → settle → verifiable certificate", async () => {
  const app = createEngine({ takeRateBps: 2000 });
  const { quote, priceUsd } = await app.quote("trk_lowtide", "creator");
  assert.ok(priceUsd > 0);
  const r = await app.license(quote.quoteId);
  assert.match(r.licenseId, /^lic_/);
  // certificate verifies and carries the right terms
  const v = app.verify(r.certificate);
  assert.equal(v.valid, true);
  assert.equal(v.claims.trackId, "trk_lowtide");
  assert.equal(v.claims.usage, "creator");
  assert.equal(v.claims.terms.redistribution, false);
  // split is recorded and matches take rate
  assert.equal(v.claims.split.takeRateBps, 2000);
  assert.equal(
    v.claims.split.rightsHolderAtomic + v.claims.split.platformAtomic,
    v.claims.pricePaidAtomic
  );
});

test("settlement actually moves and splits funds", async () => {
  const app = createEngine({ takeRateBps: 1500 });
  const before = app.stats();
  const { quote } = await app.quote("trk_neon", "commercial");
  await app.license(quote.quoteId);
  const after = app.stats();
  assert.ok(after.rightsHolderBalance > before.rightsHolderBalance);
  assert.ok(after.platformBalance > before.platformBalance);
  assert.equal(after.licensesIssued, before.licensesIssued + 1);
  assert.equal(after.settled, before.settled + 1);
});

test("a tampered certificate fails verification", async () => {
  const app = createEngine();
  const { quote } = await app.quote("trk_aurora", "creator");
  const r = await app.license(quote.quoteId);
  // flip one char in the payload segment
  const [payload, sig, pub] = r.certificate.split(".");
  const bad = `${payload.slice(0, -1)}${payload.slice(-1) === "A" ? "B" : "A"}.${sig}.${pub}`;
  const v = app.verify(bad);
  assert.equal(v.valid, false);
});

test("a quote cannot be settled twice (no double-spend)", async () => {
  const app = createEngine();
  const { quote } = await app.quote("trk_pulse", "creator");
  await app.license(quote.quoteId);
  await assert.rejects(() => app.license(quote.quoteId), /no such quote/);
});

test("an expired quote is rejected", async () => {
  let t = 1_000_000;
  const app = createEngine({ now: () => t });
  const { quote } = await app.quote("trk_meadow", "creator");
  t += 200_000; // past the 120s quote window
  await assert.rejects(() => app.license(quote.quoteId), /expired/);
});

test("underpaying a quote is rejected (fair exchange, no settle)", async () => {
  const app = createEngine();
  const { quote } = await app.quote("trk_obsidian", "commercial");
  const wallet = new AgentWallet();
  // sign a payment for far less than required
  const cheap = wallet.pay({ ...quote, price: 1 });
  await assert.rejects(() => app.license(quote.quoteId, { payment: cheap }), /PAYMENT_REJECTED|insufficient/);
  // and nothing settled
  assert.equal(app.stats().settled, 0);
});

test("real network refuses to auto-pay without a signed payment", async () => {
  const app = createEngine({ network: "solana-mainnet" });
  // can still quote
  const { quote } = await app.quote("trk_ignite", "creator");
  await assert.rejects(() => app.license(quote.quoteId), /payment required/);
});

test("verify rejects a certificate from a different issuer", async () => {
  const a = createEngine();
  const b = createEngine();
  const { quote } = await a.quote("trk_slate", "creator");
  const r = await a.license(quote.quoteId);
  // b did not issue it
  assert.equal(b.verify(r.certificate, b.engine.issuerKid).valid, false);
  // but a does
  assert.equal(a.verify(r.certificate).valid, true);
});

test("fromAtomic round-trips USDC amounts", () => {
  assert.equal(fromAtomic(150_000), 0.15);
  assert.equal(fromAtomic(1_000_000), 1);
});
