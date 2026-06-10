#!/usr/bin/env node
// rights-mcp — MCP server exposing a music-rights licensing + x402 payment
// loop to AI agents. Newline-delimited JSON-RPC 2.0 over stdio, implemented
// directly (no SDK) so there is zero supply chain and it runs anywhere Node
// runs. No LLM is ever in the loop here — this process is safe to run 24/7
// untouched and behaves identically if Claude or any API is unavailable.

import { createInterface } from "node:readline";
import { createEngine } from "./engine.js";
import { fromAtomic } from "./pricing.js";

const PROTOCOL_VERSION = "2024-11-05";

const app = createEngine({
  network: process.env.RIGHTS_NETWORK || "sim",
  takeRateBps: Number(process.env.RIGHTS_TAKE_BPS || 1500),
  payTo: process.env.RIGHTS_PAYTO || "soundraw-payout",
  soundrawApiKey: process.env.SOUNDRAW_API_KEY || undefined,
});

// --- tool definitions ------------------------------------------------------

const TOOLS = [
  {
    name: "search_tracks",
    description:
      "Search the rights catalog for music an agent is allowed to license. " +
      "Returns candidate tracks with metadata and estimated per-usage price. " +
      "Returns previews only — no licensed asset until license_track is paid.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "free-text query (mood words, instruments, use)" },
        mood: { type: "string", description: "uplifting | energetic | tense | calm" },
        genre: { type: "string" },
        bpm: { type: "number" },
        maxDurationSec: { type: "number" },
        limit: { type: "number", description: "max results (1-25, default 5)" },
      },
    },
  },
  {
    name: "quote_license",
    description:
      "Get a price quote and x402 payment requirements to license a specific " +
      "track for a given usage. Returns a quoteId to pass to license_track.",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        usage: { type: "string", description: "personal | creator | commercial | broadcast" },
      },
      required: ["trackId"],
    },
  },
  {
    name: "license_track",
    description:
      "Complete a license by paying its quote. Pass the quoteId and, on a real " +
      "network, a signed x402 payment. Funds settle ONLY after the licensed " +
      "asset and a signed license certificate are bound to the payment " +
      "(fair exchange). Returns the deliverable asset and a verifiable certificate.",
    inputSchema: {
      type: "object",
      properties: {
        quoteId: { type: "string" },
        payment: { type: "object", description: "signed x402 payment payload (omit on sim network to auto-pay)" },
      },
      required: ["quoteId"],
    },
  },
  {
    name: "verify_license",
    description:
      "Verify a license certificate offline. Returns whether it is validly " +
      "signed by the rights issuer and the license terms it carries.",
    inputSchema: {
      type: "object",
      properties: {
        certificate: { type: "string" },
        expectKid: { type: "string", description: "optional: pin the expected issuer key id" },
      },
      required: ["certificate"],
    },
  },
  {
    name: "catalog_stats",
    description: "Operational stats: issuer key, network, take rate, licenses issued, balances.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- tool handlers ---------------------------------------------------------

const handlers = {
  async search_tracks(args) {
    const tracks = await app.search(args || {});
    return {
      count: tracks.length,
      network: app.network,
      tracks: tracks.map((t) => ({
        id: t.id, title: t.title, mood: t.mood, genre: t.genre,
        bpm: t.bpm, durationSec: t.durationSec, tags: t.tags,
        rightsHolder: t.rightsHolder, previewUrl: t.previewUrl,
        estPriceUsd: t.estPriceUsd,
      })),
    };
  },

  async quote_license(args) {
    const { quote, requirements, priceUsd, track } = await app.quote(args.trackId, args.usage || "creator");
    return {
      quoteId: quote.quoteId,
      track: { id: track.id, title: track.title, rightsHolder: track.rightsHolder },
      usage: quote.usage,
      priceUsd,
      priceAtomic: quote.price,
      asset: quote.asset,
      network: quote.network,
      validBefore: quote.validBefore,
      paymentRequirements: requirements,
      hint: app.isSim
        ? "sim network: call license_track with just this quoteId to auto-pay"
        : "real network: sign an x402 payment for paymentRequirements and pass it to license_track",
    };
  },

  async license_track(args) {
    const r = await app.license(args.quoteId, { payment: args.payment });
    return {
      licenseId: r.licenseId,
      certificate: r.certificate,
      terms: r.claims.terms,
      pricePaidUsd: fromAtomic(r.claims.pricePaidAtomic),
      split: {
        rightsHolderUsd: fromAtomic(r.claims.split.rightsHolderAtomic),
        platformUsd: fromAtomic(r.claims.split.platformAtomic),
        takeRateBps: r.claims.split.takeRateBps,
      },
      deliverable: r.deliverable,
      settlementTxId: r.settlement.txId,
      note: r.deliverable.placeholder
        ? "SAMPLE BUILD: deliverable is a labelled placeholder, not real licensed audio."
        : undefined,
    };
  },

  async verify_license(args) {
    const res = app.verify(args.certificate, args.expectKid);
    if (!res.valid) return { valid: false, reason: res.reason };
    return {
      valid: true,
      issuerKid: res.issuerKid,
      licenseId: res.claims.licenseId,
      trackId: res.claims.trackId,
      licensee: res.claims.licensee,
      usage: res.claims.usage,
      terms: res.claims.terms,
      issuedAt: res.claims.issuedAt,
    };
  },

  async catalog_stats() {
    return app.stats();
  },
};

// --- JSON-RPC plumbing -----------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function err(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function dispatch(msg) {
  const { id, method, params } = msg;
  // notifications (no id) get no response
  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "rights-mcp", version: "0.1.0" },
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const handler = handlers[params?.name];
    if (!handler) return err(id, -32601, `unknown tool: ${params?.name}`);
    try {
      const result = await handler(params.arguments || {});
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      // tool errors are returned as content with isError, per MCP convention
      return ok(id, {
        content: [{ type: "text", text: `error: ${e.message}` }],
        isError: true,
      });
    }
  }
  if (id !== undefined) return err(id, -32601, `unknown method: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise
  Promise.resolve(dispatch(msg)).catch((e) => {
    if (msg && msg.id !== undefined) err(msg.id, -32603, `internal error: ${e.message}`);
  });
});

// Keep the process alive on stdio; nothing else should write to stdout.
process.stdin.resume();
