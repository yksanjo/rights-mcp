// The rights catalog — the moat seam.
//
// An AI agent that needs music does NOT need "a track." It needs a track it
// is *allowed to use*, with a paper trail proving it. That paper trail only
// has value if whoever issues it actually controls the rights. That is the
// thing only a rights holder (Soundraw) can supply — everything else in this
// server is plumbing.
//
// So the catalog is an interface, not a table. The sample catalog below makes
// the server runnable anywhere with no credentials; the Soundraw adapter is a
// drop-in that speaks the same shape against the real rights API. Nothing
// downstream (pricing, licensing, the MCP tools) knows which one it is.

/**
 * @typedef {object} Track
 * @property {string} id          stable catalog id
 * @property {string} title
 * @property {string} mood        e.g. "uplifting", "tense", "calm"
 * @property {string} genre
 * @property {number} bpm
 * @property {number} durationSec
 * @property {string[]} tags
 * @property {string} rightsHolder who can actually license this
 * @property {string} previewUrl  low-fi / watermarked preview (free to fetch)
 */

/** Interface every catalog adapter implements. */
export class CatalogAdapter {
  /** @returns {Promise<Track[]>} ranked candidates for a query. */
  async search(_query) { throw new Error("not implemented"); }
  /** @returns {Promise<Track|null>} */
  async get(_id) { throw new Error("not implemented"); }
  /**
   * Resolve the deliverable for a paid license: the full-quality asset the
   * licensee is now entitled to. Kept separate from search() so an unpaid
   * caller can never reach it.
   * @returns {Promise<{ assetUrl: string, format: string, sha256: string }>}
   */
  async deliverable(_id) { throw new Error("not implemented"); }
}

// --- scoring --------------------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().trim();

/** Cheap, deterministic relevance score. No model, no network — runs forever. */
function scoreTrack(track, q) {
  let score = 0;
  if (q.mood && norm(track.mood) === norm(q.mood)) score += 5;
  if (q.genre && norm(track.genre) === norm(q.genre)) score += 4;
  if (q.bpm) {
    const d = Math.abs(track.bpm - q.bpm);
    if (d <= 5) score += 4; else if (d <= 15) score += 2;
  }
  if (q.maxDurationSec && track.durationSec <= q.maxDurationSec) score += 1;
  if (q.minDurationSec && track.durationSec >= q.minDurationSec) score += 1;
  const terms = norm(q.text).split(/\s+/).filter(Boolean);
  const hay = norm([track.title, track.mood, track.genre, ...track.tags].join(" "));
  for (const t of terms) if (hay.includes(t)) score += 2;
  return score;
}

// --- sample catalog (no credentials, runs anywhere) -----------------------

const SAMPLE_TRACKS = [
  { id: "trk_aurora",   title: "Aurora Drift",     mood: "uplifting", genre: "ambient",     bpm: 90,  durationSec: 154, tags: ["dreamy", "synth", "intro", "calm"] },
  { id: "trk_neon",     title: "Neon Cascade",     mood: "energetic", genre: "synthwave",   bpm: 124, durationSec: 188, tags: ["retro", "driving", "trailer"] },
  { id: "trk_slate",    title: "Slate & Steel",    mood: "tense",     genre: "cinematic",   bpm: 100, durationSec: 142, tags: ["dark", "build", "documentary"] },
  { id: "trk_meadow",   title: "Meadow Light",     mood: "calm",      genre: "acoustic",    bpm: 78,  durationSec: 121, tags: ["folk", "warm", "vlog", "guitar"] },
  { id: "trk_pulse",    title: "Pulse Theory",     mood: "energetic", genre: "house",       bpm: 126, durationSec: 205, tags: ["club", "loop", "ad", "upbeat"] },
  { id: "trk_lowtide",  title: "Low Tide",         mood: "calm",      genre: "lofi",        bpm: 82,  durationSec: 168, tags: ["chill", "study", "loop", "mellow"] },
  { id: "trk_ignite",   title: "Ignite",           mood: "uplifting", genre: "pop",         bpm: 118, durationSec: 176, tags: ["bright", "vocal-ready", "promo"] },
  { id: "trk_obsidian", title: "Obsidian",         mood: "tense",     genre: "trap",        bpm: 140, durationSec: 158, tags: ["hard", "808", "gaming"] },
];

export class SampleCatalog extends CatalogAdapter {
  constructor({ rightsHolder = "rights-mcp:sample" } = {}) {
    super();
    this.tracks = SAMPLE_TRACKS.map((t) => ({
      ...t,
      rightsHolder,
      previewUrl: `https://example.invalid/preview/${t.id}.mp3`,
    }));
  }

  async search(query = {}) {
    const limit = Math.max(1, Math.min(25, query.limit || 5));
    return this.tracks
      .map((t) => ({ t, s: scoreTrack(t, query) }))
      .filter((x) => x.s > 0 || !hasFilters(query))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.t);
  }

  async get(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  async deliverable(id) {
    const t = await this.get(id);
    if (!t) return null;
    // Sample build returns a labelled placeholder, NOT real licensed audio.
    // The Soundraw adapter returns a signed, time-boxed download of the master.
    return {
      assetUrl: `https://example.invalid/master/${id}.wav`,
      format: "wav",
      sha256: "0".repeat(64),
      placeholder: true,
    };
  }
}

function hasFilters(q) {
  return Boolean(q.mood || q.genre || q.bpm || q.text || q.maxDurationSec || q.minDurationSec);
}

// --- Soundraw adapter (the real moat — stubbed until credentialed) ---------

/**
 * Drop-in for the live Soundraw rights catalog. Same interface as
 * SampleCatalog; the rest of the server is unchanged when this is wired in.
 * Left as an explicit, honest stub: it throws unless given an apiKey/fetch,
 * so a demo never silently pretends to hold real rights.
 */
export class SoundrawCatalog extends CatalogAdapter {
  constructor({ apiKey, baseUrl = "https://api.soundraw.io", fetchImpl = globalThis.fetch } = {}) {
    super();
    if (!apiKey) throw new Error("SoundrawCatalog requires an apiKey (real rights, real credentials)");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.rightsHolder = "soundraw";
  }
  // Implement search/get/deliverable against the Soundraw API when the
  // mandate lands. Shape matches SampleCatalog so nothing downstream changes.
}

export { scoreTrack };
