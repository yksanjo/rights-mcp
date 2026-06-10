#!/usr/bin/env node
// rights-mcp CLI — drives the same engine the MCP server exposes, with no MCP
// client and no LLM. This is the "Claude is gone" path: the licensing loop is
// fully usable by a human or a plain script. Also the fastest way to demo it.
//
//   rights search "calm lofi"        rights quote trk_lowtide creator
//   rights license <quoteId>         rights verify <certificate>
//   rights demo                      rights stats

import { createEngine } from "./engine.js";
import { fromAtomic } from "./pricing.js";

const app = createEngine({
  network: process.env.RIGHTS_NETWORK || "sim",
  takeRateBps: Number(process.env.RIGHTS_TAKE_BPS || 1500),
  soundrawApiKey: process.env.SOUNDRAW_API_KEY || undefined,
});

const [cmd, ...rest] = process.argv.slice(2);
const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));

async function main() {
  switch (cmd) {
    case "search": {
      const text = rest.join(" ");
      const tracks = await app.search({ text, limit: 8 });
      out(tracks.map((t) => ({
        id: t.id, title: t.title, mood: t.mood, genre: t.genre, bpm: t.bpm,
        durationSec: t.durationSec, creatorPriceUsd: t.estPriceUsd.creator,
      })));
      break;
    }
    case "quote": {
      const [trackId, usage = "creator"] = rest;
      const { quote, priceUsd } = await app.quote(trackId, usage);
      out({ quoteId: quote.quoteId, usage, priceUsd, validBefore: quote.validBefore });
      break;
    }
    case "license": {
      const [quoteId] = rest;
      const r = await app.license(quoteId);
      out({
        licenseId: r.licenseId,
        pricePaidUsd: fromAtomic(r.claims.pricePaidAtomic),
        split: {
          rightsHolderUsd: fromAtomic(r.claims.split.rightsHolderAtomic),
          platformUsd: fromAtomic(r.claims.split.platformAtomic),
        },
        deliverable: r.deliverable,
        certificate: r.certificate,
      });
      break;
    }
    case "verify": {
      const [cert] = rest;
      out(app.verify(cert));
      break;
    }
    case "demo": {
      console.log("# rights-mcp demo — full license loop, no LLM, no chain\n");
      const tracks = await app.search({ mood: "calm", text: "lofi study" });
      const pick = tracks[0];
      console.log(`1. search → picked "${pick.title}" (${pick.id}), creator price $${pick.estPriceUsd.creator}`);
      const { quote, priceUsd } = await app.quote(pick.id, "creator");
      console.log(`2. quote  → ${quote.quoteId}, $${priceUsd} for ${quote.usage} usage`);
      const r = await app.license(quote.quoteId);
      console.log(`3. pay+settle → license ${r.licenseId}, tx ${r.settlement.txId}`);
      console.log(`   split: rights-holder $${fromAtomic(r.claims.split.rightsHolderAtomic)}, platform $${fromAtomic(r.claims.split.platformAtomic)}`);
      const v = app.verify(r.certificate);
      console.log(`4. verify → ${v.valid ? "VALID" : "INVALID"} certificate, terms: ${JSON.stringify(v.claims.terms)}`);
      console.log("\nstats:", JSON.stringify(app.stats()));
      break;
    }
    case "stats":
      out(app.stats());
      break;
    default:
      out("usage: rights <search|quote|license|verify|demo|stats> [args]");
  }
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
