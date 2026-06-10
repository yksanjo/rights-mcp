// Signed-receipt primitives for x402-pact. Ed25519 over canonical JSON,
// zero dependencies (node:crypto only).
//
// Token format: b64u(claimsJSON) + "." + b64u(signature) + "." + b64u(spkiDER)
// Tokens are self-verifying (carry the public key); binding a key to an
// identity is the ledger's job (the pact records the server kid at /deliver,
// clients pin the pact's kid from GET /keys).

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as edSign,
  verify as edVerify,
  randomBytes,
} from "node:crypto";

export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const fromB64u = (s) => Buffer.from(s, "base64url");

/** sha256 hex digest of a Buffer/string. */
export function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: sorted keys at every level, so digests are stable. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Key id: first 16 hex chars of sha256(spki DER). Stable, short, collision-safe enough for a ledger. */
export function kidOf(spkiDer) {
  return digest(spkiDer).slice(0, 16);
}

/** Generate an Ed25519 keypair. Returns { privateKey, publicKey, spkiDer, kid }. */
export function newKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKey, spkiDer, kid: kidOf(spkiDer) };
}

/** Serialize a keypair to JSON-safe form (pkcs8/spki DER, b64url). */
export function exportKeypair(kp) {
  return {
    privateKeyPkcs8: b64u(kp.privateKey.export({ type: "pkcs8", format: "der" })),
    publicKeySpki: b64u(kp.spkiDer),
    kid: kp.kid,
  };
}

/** Restore a keypair exported with exportKeypair(). */
export function importKeypair(json) {
  const privateKey = createPrivateKey({
    key: fromB64u(json.privateKeyPkcs8),
    format: "der",
    type: "pkcs8",
  });
  const spkiDer = fromB64u(json.publicKeySpki);
  const publicKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  return { privateKey, publicKey, spkiDer, kid: kidOf(spkiDer) };
}

/** Sign claims (a plain object) into a self-verifying token. */
export function signToken(claims, keypair) {
  const payload = b64u(canonical(claims));
  const sig = edSign(null, Buffer.from(payload), keypair.privateKey);
  return `${payload}.${b64u(sig)}.${b64u(keypair.spkiDer)}`;
}

/**
 * Verify a token. Returns { claims, kid } on success, null on any failure.
 * If expectedKid is given, the embedded key must match it.
 */
export function verifyToken(token, expectedKid = null) {
  try {
    const [payload, sigB64, pubB64] = String(token).split(".");
    if (!payload || !sigB64 || !pubB64) return null;
    const spkiDer = fromB64u(pubB64);
    const kid = kidOf(spkiDer);
    if (expectedKid && kid !== expectedKid) return null;
    const publicKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const ok = edVerify(null, Buffer.from(payload), publicKey, fromB64u(sigB64));
    if (!ok) return null;
    return { claims: JSON.parse(fromB64u(payload).toString("utf8")), kid };
  } catch {
    return null;
  }
}

/** Random nonce for payment authorizations. */
export function nonce() {
  return randomBytes(16).toString("hex");
}
