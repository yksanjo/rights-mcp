// Pricing & x402 payment requirements.
//
// The price depends on *usage*, not the track: the same master is a few cents
// for a personal vlog and dollars for a paid ad. This is where the revenue
// lives — `takeRateBps` is the platform's cut of every settled license, the
// rest is the rights holder's. Both are recorded on the signed certificate so
// the split is auditable, not a trust-me number.
//
// Amounts are atomic units of USDC (6 decimals): 10_000 = $0.01.

const USDC_DECIMALS = 6;
export const usd = (dollars) => Math.round(dollars * 10 ** USDC_DECIMALS);
export const fromAtomic = (atomic) => Number(atomic) / 10 ** USDC_DECIMALS;

/**
 * Usage tiers. `mult` scales a track's base price; the base reflects the
 * exposure/commercial risk the license covers.
 */
export const USAGE_TIERS = Object.freeze({
  personal:    { mult: 1,   base: usd(0.05), label: "Personal / non-monetized" },
  creator:     { mult: 3,   base: usd(0.05), label: "Monetized creator (YouTube/TikTok)" },
  commercial:  { mult: 20,  base: usd(0.05), label: "Commercial (brand / paid ad)" },
  broadcast:   { mult: 120, base: usd(0.05), label: "Broadcast / theatrical" },
});

/**
 * @param {object} opts
 * @param {string} opts.usage      one of USAGE_TIERS
 * @param {number} [opts.durationSec] track length (longer = marginally more)
 * @returns {number} price in atomic USDC
 */
export function priceFor({ usage = "creator", durationSec = 120 } = {}) {
  const tier = USAGE_TIERS[usage];
  if (!tier) throw new Error(`unknown usage tier: ${usage} (have: ${Object.keys(USAGE_TIERS).join(", ")})`);
  const durationFactor = 1 + Math.max(0, durationSec - 120) / 600; // +1 per 10 min over 2 min
  return Math.round(tier.base * tier.mult * durationFactor);
}

/** Split a settled price into rights-holder vs platform shares. */
export function splitRevenue(amountAtomic, takeRateBps) {
  const platform = Math.floor((Number(amountAtomic) * takeRateBps) / 10_000);
  return { platform, rightsHolder: Number(amountAtomic) - platform, takeRateBps };
}

/**
 * Build x402 paymentRequirements for a license. Mirrors the x402 "accepts"
 * shape so a standard x402 client can pay it; the sim network keeps it
 * runnable with no chain.
 */
export function buildRequirements({ price, payTo, asset, network, resource, description }) {
  return {
    scheme: network.startsWith("sim") ? "exact-sim" : "exact",
    network,
    maxAmountRequired: String(price),
    resource,
    description,
    mimeType: "application/json",
    payTo,
    asset,
    maxTimeoutSeconds: 120,
  };
}
