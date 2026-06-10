# rights-mcp

**The rights layer for the agent economy.** An [MCP](https://modelcontextprotocol.io) server that lets an AI agent **search, license, and pay for rights-clean music per use** — and walk away with a **verifiable license certificate** proving it's allowed to use the track.

Built on [x402](https://www.x402.org/) for payment and the fair-exchange escrow pattern from [x402-pact](https://github.com/yksanjo/x402-pact): the agent's money only moves once the licensed asset *and* a signed certificate are bound to the payment. Zero dependencies, no SDK, no LLM in the loop — it runs anywhere Node runs and behaves identically whether or not any AI service is reachable.

## Why this exists

An agent generating a video, ad, or stream doesn't need "a track." It needs a track it is **allowed to use**, with a paper trail proving it. That paper trail is only worth anything if whoever issues it **actually controls the rights**. That's the moat: the catalog adapter is the one piece a generic tool can't fake — it's where a real rights holder (e.g. a music catalog like Soundraw) plugs in.

Everything else here — pricing, escrow, certificates, the MCP wire protocol — is plumbing, and it's all built and tested.

## The loop

```
search_tracks ──▶ quote_license ──▶ license_track ──▶ verify_license
   (previews)       (price + x402     (pay → settle      (offline proof
                     requirements)     ONLY on delivery)   of rights)
```

```bash
npm run demo
# 1. search → picked "Low Tide" (trk_lowtide), creator price $0.162
# 2. quote  → q_7ab4..., $0.162 for creator usage
# 3. pay+settle → license lic_498f..., tx sim-settle:3a6b...
#    split: rights-holder $0.1377, platform $0.0243
# 4. verify → VALID certificate
```

## MCP tools

| Tool | What it does |
|------|--------------|
| `search_tracks` | Query the catalog by mood/genre/bpm/text. Returns previews + per-usage price estimates. No licensed asset. |
| `quote_license` | Price a track for a usage tier (`personal`/`creator`/`commercial`/`broadcast`); returns x402 `paymentRequirements` + a `quoteId`. |
| `license_track` | Pay a quote. Funds settle **only after** the asset + a signed certificate are bound to the payment (fair exchange). Returns the deliverable + certificate. |
| `verify_license` | Verify a certificate offline: validly signed by the rights issuer, with its terms. |
| `catalog_stats` | Issuer key, network, take rate, licenses issued, balances. |

### Run it as an MCP server

```bash
npm start          # stdio JSON-RPC, ready for any MCP client
```

Claude Desktop / Claude Code `mcpServers` entry:

```json
{
  "mcpServers": {
    "rights": { "command": "node", "args": ["/abs/path/to/rights-mcp/src/server.js"] }
  }
}
```

### Or drive it with no client (the "no LLM" path)

```bash
rights search "calm lofi"
rights quote trk_lowtide creator
rights license <quoteId>
rights verify <certificate>
rights stats
```

## Economics

`license_track` settles the price and splits it on the certificate: **rights holder** gets their share, the **platform** keeps `takeRateBps` (default 15%). The split is signed into every license, so it's auditable, not a trust-me number. Set with `RIGHTS_TAKE_BPS`.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `RIGHTS_NETWORK` | `sim` | `sim` = no chain, auto-pays a funded demo wallet. A real network (e.g. `solana-mainnet`) **requires** a signed x402 payment. |
| `RIGHTS_TAKE_BPS` | `1500` | Platform cut in basis points. |
| `RIGHTS_PAYTO` | `soundraw-payout` | Rights-holder payout address. |
| `SOUNDRAW_API_KEY` | — | When set, swaps the sample catalog for the real Soundraw rights catalog. |

## What's real vs. stubbed (honest seams)

This is a working spine with two deliberate, clearly-labelled seams where production drops in:

- **Catalog** — ships with an 8-track sample catalog so it runs with no credentials. `SoundrawCatalog` is the drop-in for the real rights API (same interface; the rest of the server is unchanged). Sample deliverables are **labelled placeholders, not real licensed audio**.
- **Settlement** — `SimBank` proves the full escrow→split loop with no chain. A Solana facilitator adapter (settle a partially-signed tx / durable nonce) drops in behind the same calls. Real on-chain settlement is **not** yet wired.

Everything else — escrow/fair-exchange semantics, Ed25519 certificate signing & verification, double-spend / expiry / underpayment rejection, the MCP protocol — is real and covered by 17 no-mock tests (`npm test`), including a full roundtrip against the actual server over stdio.

## License

MIT
