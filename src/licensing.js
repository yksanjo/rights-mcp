// The licensing engine: the fair-exchange core.
//
// Lifecycle of one license, escrow-style (the x402-pact pattern, narrowed to
// what a license needs):
//
//   quote ──▶ HELD (signed payment escrowed) ──deliver──▶ DELIVERED
//                                                  │
//                                          settle (split paid)
//                                                  ▼
//                                               SETTLED  ──▶ signed certificate
//
// The agent's funds only move once the deliverable AND a verifiable license
// certificate have been bound to the payment. If delivery fails, the signed
// authorization is simply never settled — the agent is never charged. That
// fair-exchange property is the whole reason an agent can safely pay an
// unfamiliar rights server.
//
// Everything here is deterministic Node + node:crypto. No LLM, no network in
// the settlement path: it runs 24/7 untouched and is safe if Claude or any
// API is gone.

import { newKeypair, signToken, verifyToken, digest, canonical, nonce } from "./receipts.js";
import { splitRevenue, fromAtomic } from "./pricing.js";

export class LicenseError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * Minimal simulated settlement bank. Same role as x402-pact's SimBank: proves
 * the loop end-to-end with no chain. Swap for a Solana facilitator adapter
 * (settle a partially-signed tx / durable nonce) and the engine is unchanged.
 */
export class SimBank {
  constructor() { this.balances = new Map(); this.spent = new Set(); this.settled = 0; }
  fund(addr, amount) { this.balances.set(addr, (this.balances.get(addr) || 0) + Number(amount)); }
  balance(addr) { return this.balances.get(addr) || 0; }

  /** Verify a signed authorization covers the required price and isn't spent. */
  verify(payment, price, now) {
    const auth = payment?.payload?.authorization;
    const sig = payment?.payload?.signature;
    if (!auth || !sig) return { ok: false, reason: "malformed payment" };
    const v = verifyToken(sig);
    if (!v) return { ok: false, reason: "bad signature" };
    if (`sim:${v.kid}` !== auth.from) return { ok: false, reason: "signer is not the payer" };
    if (String(v.claims.value) !== String(auth.value) || v.claims.nonce !== auth.nonce) {
      return { ok: false, reason: "signature does not cover this authorization" };
    }
    if (Number(auth.value) < Number(price)) return { ok: false, reason: "insufficient amount" };
    if (now >= auth.validBefore) return { ok: false, reason: "authorization expired" };
    if (this.spent.has(auth.nonce)) return { ok: false, reason: "authorization already spent" };
    if (this.balance(auth.from) < Number(auth.value)) return { ok: false, reason: "insufficient funds" };
    return { ok: true, auth };
  }

  /** Move funds and split between rights holder and platform. Idempotent per nonce. */
  settle(auth, split, payTo, platformAddr) {
    if (this.spent.has(auth.nonce)) throw new LicenseError("ALREADY_SPENT", "double settle");
    this.spent.add(auth.nonce);
    this.balances.set(auth.from, this.balance(auth.from) - Number(auth.value));
    this.balances.set(payTo, this.balance(payTo) + split.rightsHolder);
    this.balances.set(platformAddr, this.balance(platformAddr) + split.platform);
    this.settled++;
    return { txId: `sim-settle:${digest(auth.nonce).slice(0, 16)}`, at: Date.now };
  }
}

export class LicenseEngine {
  /**
   * @param {object} opts
   * @param {import('./catalog.js').CatalogAdapter} opts.catalog
   * @param {object} opts.bank        settlement adapter (SimBank or real facilitator)
   * @param {string} opts.payTo       rights-holder payout address
   * @param {string} opts.platformAddr platform fee address
   * @param {string} opts.asset       payment asset id
   * @param {string} opts.network     payment network (e.g. "sim", "solana-mainnet")
   * @param {number} opts.takeRateBps platform cut in basis points (e.g. 1500 = 15%)
   * @param {() => number} [opts.now] injectable clock
   * @param {object} [opts.issuerKey] issuer keypair (generated if absent)
   */
  constructor({ catalog, bank, payTo, platformAddr, asset = "USDC", network = "sim", takeRateBps = 1500, now = Date.now, issuerKey } = {}) {
    if (!catalog) throw new Error("LicenseEngine requires a catalog");
    if (!bank) throw new Error("LicenseEngine requires a settlement bank");
    this.catalog = catalog;
    this.bank = bank;
    this.payTo = payTo || "rights-holder";
    this.platformAddr = platformAddr || "rights-mcp-platform";
    this.asset = asset;
    this.network = network;
    this.takeRateBps = takeRateBps;
    this.now = now;
    this.issuerKey = issuerKey || newKeypair();
    this.pending = new Map(); // quoteId -> quote (HELD)
    this.licenses = new Map(); // licenseId -> certificate claims
  }

  get issuerKid() { return this.issuerKey.kid; }

  /**
   * Quote a license: bind a track + usage to a price and a one-time challenge.
   * Returns x402-style requirements the agent signs a payment against.
   */
  quote(track, { usage, price, validForMs = 120_000 }) {
    const quoteId = `q_${nonce()}`;
    const issuedAt = this.now();
    const quote = {
      quoteId, trackId: track.id, rightsHolder: track.rightsHolder,
      usage, price, asset: this.asset, network: this.network,
      payTo: this.payTo, issuedAt, validBefore: issuedAt + validForMs,
      state: "HELD",
    };
    this.pending.set(quoteId, quote);
    return quote;
  }

  /**
   * Fulfil a quote against a signed payment: verify → settle → issue a signed
   * certificate and release the deliverable. The certificate is the product.
   */
  async fulfil(quoteId, payment) {
    const quote = this.pending.get(quoteId);
    if (!quote) throw new LicenseError("UNKNOWN_QUOTE", "no such quote (or already used / expired)");
    const now = this.now();
    if (now >= quote.validBefore) {
      this.pending.delete(quoteId);
      throw new LicenseError("QUOTE_EXPIRED", "quote expired before payment");
    }
    const check = this.bank.verify(payment, quote.price, now);
    if (!check.ok) throw new LicenseError("PAYMENT_REJECTED", check.reason);

    const split = splitRevenue(quote.price, this.takeRateBps);
    const deliverable = await this.catalog.deliverable(quote.trackId);
    if (!deliverable) throw new LicenseError("NO_DELIVERABLE", "track has no deliverable asset");

    // Fair exchange: only now does money move.
    const settlement = this.bank.settle(check.auth, split, quote.payTo, this.platformAddr);
    this.pending.delete(quoteId);

    const licenseId = `lic_${nonce()}`;
    const claims = {
      v: 1,
      licenseId,
      trackId: quote.trackId,
      rightsHolder: quote.rightsHolder,
      licensee: check.auth.from,
      usage: quote.usage,
      pricePaidAtomic: quote.price,
      asset: quote.asset,
      network: quote.network,
      split: { rightsHolderAtomic: split.rightsHolder, platformAtomic: split.platform, takeRateBps: split.takeRateBps },
      paymentDigest: digest(canonical(payment)),
      settlementTxId: settlement.txId,
      issuedAt: now,
      terms: {
        sublicensable: false,
        redistribution: false,
        exclusive: false,
        scope: quote.usage,
      },
      assetSha256: deliverable.sha256,
    };
    const certificate = signToken(claims, this.issuerKey);
    this.licenses.set(licenseId, claims);
    return { licenseId, certificate, claims, deliverable, settlement };
  }

  /**
   * Verify a license certificate. Returns { valid, claims, reason }. Pure
   * crypto — anyone can verify offline given the issuer kid.
   */
  verify(certificate, { expectKid } = {}) {
    const res = verifyToken(certificate, expectKid || this.issuerKid);
    if (!res) return { valid: false, reason: "signature invalid or wrong issuer" };
    return { valid: true, claims: res.claims, issuerKid: res.kid };
  }

  metrics() {
    return {
      issuerKid: this.issuerKid,
      network: this.network,
      takeRateBps: this.takeRateBps,
      pendingQuotes: this.pending.size,
      licensesIssued: this.licenses.size,
      settled: this.bank.settled,
      platformBalance: fromAtomic(this.bank.balance(this.platformAddr)),
      rightsHolderBalance: fromAtomic(this.bank.balance(this.payTo)),
    };
  }
}
