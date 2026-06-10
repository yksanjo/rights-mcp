// Agent-side wallet: signs x402 payment authorizations. Mirrors x402-pact's
// SimWallet. In production this is the agent's real Solana signer; here it
// signs the same authorization shape so the loop is exercised end-to-end.

import { newKeypair, signToken, nonce } from "./receipts.js";

export class AgentWallet {
  constructor(keypair) {
    this.keypair = keypair || newKeypair();
    this.address = `sim:${this.keypair.kid}`;
  }

  /** Build a signed X-PAYMENT payload for a quote/requirements. */
  pay(quote, { now = Date.now, validForMs = 90_000 } = {}) {
    const authorization = {
      from: this.address,
      to: quote.payTo,
      value: String(quote.price),
      asset: quote.asset,
      network: quote.network,
      nonce: nonce(),
      validBefore: now() + validForMs,
    };
    return {
      x402Version: 1,
      scheme: quote.network.startsWith("sim") ? "exact-sim" : "exact",
      network: quote.network,
      payload: { authorization, signature: signToken(authorization, this.keypair) },
    };
  }
}
