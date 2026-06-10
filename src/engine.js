// Wires a catalog + settlement bank + LicenseEngine into one object the MCP
// tools and CLI call. Configuration comes from plain options/env so the
// server boots with zero credentials in sample/sim mode and upgrades to the
// real Soundraw catalog + Solana facilitator by swapping two adapters.

import { SampleCatalog, SoundrawCatalog } from "./catalog.js";
import { LicenseEngine, SimBank } from "./licensing.js";
import { AgentWallet } from "./wallet.js";
import { priceFor, USAGE_TIERS, buildRequirements, fromAtomic } from "./pricing.js";

export function createEngine(opts = {}) {
  const {
    catalog: catalogOpt,
    network = "sim",
    takeRateBps = 1500,
    payTo = "soundraw-payout",
    platformAddr = "rights-mcp-platform",
    asset = "USDC",
    now = Date.now,
    demoFunding = 1_000_000_000, // sim: fund the demo wallet so the loop closes
    soundrawApiKey,
  } = opts;

  const catalog = catalogOpt
    || (soundrawApiKey ? new SoundrawCatalog({ apiKey: soundrawApiKey }) : new SampleCatalog());

  const bank = new SimBank();
  const engine = new LicenseEngine({ catalog, bank, payTo, platformAddr, asset, network, takeRateBps, now });

  // Demo wallet: only meaningful on the sim network. Lets an MCP agent that has
  // no signer of its own still complete a license so the value is visible.
  // On a real network this is disabled — the agent must bring a signed payment.
  const isSim = network.startsWith("sim");
  const demoWallet = isSim ? new AgentWallet() : null;
  if (demoWallet) bank.fund(demoWallet.address, demoFunding);

  return {
    engine,
    catalog,
    network,
    isSim,

    async search(query = {}) {
      const tracks = await catalog.search(query);
      return tracks.map((t) => ({
        ...t,
        estPrice: USAGE_TIERS,
        estPriceUsd: {
          personal: fromAtomic(priceFor({ usage: "personal", durationSec: t.durationSec })),
          creator: fromAtomic(priceFor({ usage: "creator", durationSec: t.durationSec })),
          commercial: fromAtomic(priceFor({ usage: "commercial", durationSec: t.durationSec })),
        },
      }));
    },

    async quote(trackId, usage = "creator") {
      const track = await catalog.get(trackId);
      if (!track) throw new Error(`unknown track: ${trackId}`);
      if (!USAGE_TIERS[usage]) throw new Error(`unknown usage: ${usage}`);
      const price = priceFor({ usage, durationSec: track.durationSec });
      const q = engine.quote(track, { usage, price });
      const requirements = buildRequirements({
        price, payTo: q.payTo, asset, network,
        resource: `rights-mcp://license/${trackId}`,
        description: `${usage} license for "${track.title}" by ${track.rightsHolder}`,
      });
      return { quote: q, requirements, priceUsd: fromAtomic(price), track };
    },

    /**
     * Complete a license. If `payment` is supplied, fair-exchange against it.
     * Otherwise, on the sim network, auto-pay from the demo wallet so an agent
     * without a signer still sees the deliverable + certificate.
     */
    async license(quoteId, { payment } = {}) {
      let pay = payment;
      if (!pay) {
        if (!demoWallet) throw new Error("payment required: no demo wallet on a real network");
        const q = engine.pending.get(quoteId);
        if (!q) throw new Error("no such quote (or already used / expired)");
        pay = demoWallet.pay(q, { now });
      }
      return engine.fulfil(quoteId, pay);
    },

    verify(certificate, expectKid) {
      return engine.verify(certificate, { expectKid });
    },

    stats() {
      return { ...engine.metrics(), demoWallet: demoWallet?.address || null };
    },
  };
}
