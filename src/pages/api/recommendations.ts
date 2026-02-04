import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Reason = { label: string; detail: string };

type Recommendation = {
  recId: string;
  workKey: string | null;
  isbn: string;
  title: string;
  authors: string;
  coverUrl?: string | null;
  description?: string | null;
  score: number;
  reasons: Reason[];
  subjects: string[];
};

type Profile = {
  likedCount: number;
  topSubjects: { subject: string; weight: number }[];
  topAuthors: { author: string; weight: number }[];
};

type DebugInfo = Record<string, any>;

type OpenLibraryDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
  isbn?: string[];
  subject?: string[];
  language?: string[];
  first_sentence?: string | { value?: string } | Array<string | { value?: string }>;
};

type OpenLibrarySearchCacheEntry = {
  expiresAt: number;
  docs: OpenLibraryDoc[];
};

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 120;
const OPENLIBRARY_QUERY_CONCURRENCY = 4;
const OWNED_WORK_LOOKUP_CONCURRENCY = 8;
const MAX_RECS_PER_PRIMARY_AUTHOR = 3;
const STORY_WEIGHT = 60;
const TOPIC_WEIGHT = 28;
const AUTHOR_WEIGHT = 12;
const GERMAN_SCORE_BONUS = 4;
const WIKIDATA_LANGS = ["en", "de", "es", "fr"] as const;

const openLibrarySearchCache = new Map<string, OpenLibrarySearchCacheEntry>();
const openLibraryWorkWikidataCache = new Map<string, string | null>();
const wikidataTitleAuthorCache = new Map<string, string | null>();
const openLibraryWorkDescriptionCache = new Map<string, string | null>();
const wikidataDescriptionCache = new Map<string, string | null>();

function jsonOk(res: NextApiResponse, data: any) {
  res.status(200).json({ ok: true, ...data });
}

function jsonErr(res: NextApiResponse, status: number, error: any) {
  res.status(status).json({ ok: false, error: String(error ?? "Unknown error") });
}

/** -----------------------------
 *  Session helper (bv_session)
 *  ----------------------------- */
async function getSessionUser(req: NextApiRequest) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)bv_session=([^;]+)/);
  const token = m?.[1];
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    select: { userId: true },
  });
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true },
  });
  return user ?? null;
}

/** -----------------------------
 *  Small utilities
 *  ----------------------------- */
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickPrimaryAuthor(authors: string) {
  return (authors || "").split(",")[0]?.trim() || "";
}

function authorLastName(author: string) {
  const parts = (author || "").trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : "";
}

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "der", "die", "das", "ein", "eine", "und", "oder", "von", "zu", "mit", "im", "am",
  "le", "la", "les", "de", "des", "du", "et", "un", "une",
  "el", "los", "las", "del", "y", "un", "una",
  "il", "lo", "gli", "i", "dei", "degli",
]);

function primaryAuthorKey(authors: string) {
  return norm(pickPrimaryAuthor(authors));
}

function titleTokens(title: string) {
  return norm(title)
    .split(" ")
    .filter(Boolean)
    .filter((t) => !TITLE_STOPWORDS.has(t));
}

function titleTokenKey(title: string) {
  return titleTokens(title).slice(0, 10).join(" ");
}

function parseSubjects(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }

  if (typeof raw !== "string") return [];
  const t = raw.trim();
  if (!t) return [];

  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x).trim()).filter(Boolean);
    }
  } catch {
    // fall back to delimiter parsing
  }

  if (t.includes(",")) {
    return t.split(",").map((x) => x.trim()).filter(Boolean);
  }

  return [t];
}

const STORY_STOPWORDS = new Set([
  "fiction", "general", "novel", "book", "books", "story", "stories", "literature",
  "roman", "romane", "romanzo", "romance", "classic", "classics",
  "the", "and", "for", "with", "from", "into", "about", "that", "this", "have", "your",
  "der", "die", "das", "und", "mit", "von", "ein", "eine", "oder", "auch", "ueber",
  "del", "los", "las", "con", "para", "una", "uno", "por", "sobre",
  "le", "la", "les", "des", "avec", "dans", "pour", "une", "sur",
]);

const GENERIC_SUBJECTS = new Set([
  "fiction",
  "fiction general",
  "general",
  "literature",
  "novel",
  "novels",
  "roman",
  "romance",
  "classic",
  "classics",
]);

const MOTIF_LEXICON: Record<string, string[]> = {
  coming_of_age: [
    "coming", "age", "adolescent", "adolescence", "teen", "teenager", "youth", "young", "boy", "girl", "bildungsroman",
  ],
  mentorship: [
    "mentor", "teacher", "guide", "elder", "older", "old", "wisdom", "apprentice", "student", "master",
  ],
  friendship: [
    "friend", "friendship", "companionship", "companions", "buddy", "bond",
  ],
  grief_loss: [
    "grief", "loss", "bereavement", "mourning", "widow", "widower", "death", "dead", "illness", "cancer",
  ],
  self_discovery: [
    "journey", "search", "identity", "self", "meaning", "healing", "growth", "awakening", "solitude", "loneliness",
  ],
  books_literary_world: [
    "books", "book", "bookseller", "library", "writer", "author", "literary", "manuscript", "publisher",
  ],
};


const MOTIF_LABEL_DE: Record<string, string> = {
  coming_of_age: "Erwachsenwerden",
  mentorship: "Mentorenschaft",
  friendship: "Freundschaft",
  grief_loss: "Verlust und Trauer",
  self_discovery: "Selbstfindung",
  books_literary_world: "Buecherwelt",
};


const MOTIF_EXPLAIN_DE: Record<string, string> = {
  coming_of_age: "eine Phase des Aufbruchs und Reifens",
  mentorship: "praegende Begegnungen zwischen juengeren und aelteren Figuren",
  friendship: "enge Beziehungen und Freundschaft als zentrales Thema",
  grief_loss: "Verlust, Trauer und den Umgang damit",
  self_discovery: "innere Entwicklung und Selbstfindung",
  books_literary_world: "eine starke Verbindung zur Welt der Buecher und Literatur",
};

function isGenericSubject(subject: string) {
  const n = norm(subject).replace(/\s+/g, " ");
  return GENERIC_SUBJECTS.has(n);
}

function extractMotifsFromText(input: string): string[] {
  const tokens = extractStoryTerms(input);
  const found = new Set<string>();

  for (const [motif, keywords] of Object.entries(MOTIF_LEXICON)) {
    for (const kw of keywords) {
      if (tokens.includes(norm(kw))) {
        found.add(motif);
        break;
      }
    }
  }

  return Array.from(found);
}


function extractStoryTerms(input: string): string[] {
  return norm(input)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .filter((x) => !STORY_STOPWORDS.has(x));
}

type StoryProfile = {
  weights: Map<string, number>;
  topTerms: { term: string; weight: number }[];
  motifWeights: Map<string, number>;
  topMotifs: { motif: string; weight: number }[];
  normDenominator: number;
};

function buildStoryProfile(entries: any[], minRating: number): StoryProfile {
  const liked = entries.filter(
    (e) => e.status === "read" && typeof e.rating === "number" && (e.rating ?? 0) >= minRating
  );

  const weights = new Map<string, number>();
  const motifWeights = new Map<string, number>();

  for (const e of liked) {
    const rating = typeof e.rating === "number" ? e.rating : minRating;
    const w = clamp(rating, minRating, 10) / 10;

    const textParts = [
      String(e.title || ""),
      String(e.description || ""),
      String(e.notes || ""),
      parseSubjects(e.subjects).join(" "),
    ].filter(Boolean);

    const merged = textParts.join(" ");
    const terms = Array.from(new Set(extractStoryTerms(merged)));
    for (const t of terms) {
      weights.set(t, (weights.get(t) ?? 0) + w);
    }

    const motifs = extractMotifsFromText(merged);
    for (const m of motifs) {
      motifWeights.set(m, (motifWeights.get(m) ?? 0) + w);
    }
  }

  const topTerms = Array.from(weights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term, weight]) => ({ term, weight }));

  const topMotifs = Array.from(motifWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([motif, weight]) => ({ motif, weight }));

  const normDenominator =
    topTerms.slice(0, 10).reduce((acc, x) => acc + x.weight, 0) +
    topMotifs.slice(0, 4).reduce((acc, x) => acc + x.weight * 1.5, 0) || 1;

  return { weights, topTerms, motifWeights, topMotifs, normDenominator };
}

function tokenOverlapRatio(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter += 1;
  }
  const den = Math.max(sa.size, sb.size);
  return den === 0 ? 0 : inter / den;
}

function isTitleNearDuplicateSameAuthor(aTitle: string, bTitle: string) {
  const ak = titleTokenKey(aTitle);
  const bk = titleTokenKey(bTitle);
  if (!ak || !bk) return false;
  if (ak === bk) return true;
  if (ak.includes(bk) || bk.includes(ak)) return true;

  const at = ak.split(" ").filter(Boolean);
  const bt = bk.split(" ").filter(Boolean);
  const overlap = tokenOverlapRatio(at, bt);
  return overlap >= 0.7;
}

async function pMapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  if (items.length === 0) return [] as R[];

  const out: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      out[i] = await mapper(items[i]);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
  await Promise.all(workers);
  return out;
}

/** -----------------------------
 *  HTTP fetch helpers (timeout)
 *  ----------------------------- */
async function fetchJson(url: string, timeoutMs = 12000, headers?: Record<string, string>) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "bookvault/1.0 (personal)",
        ...(headers || {}),
      },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** -----------------------------
 *  OpenLibrary helpers
 *  ----------------------------- */
function coverFromIsbn(isbn: string) {
  return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg`;
}

// Used for owned entries (small number), but kept global for cross-request wins.
const olIsbnWorkCache = new Map<string, string | null>();

async function openLibraryIsbnToWorkKey(isbn: string): Promise<string | null> {
  const key = String(isbn || "").trim();
  if (!key) return null;
  if (olIsbnWorkCache.has(key)) return olIsbnWorkCache.get(key)!;

  try {
    const j = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(key)}.json`, 12000);
    const works = (j?.works || []) as Array<{ key?: string }>;
    const wk = works?.[0]?.key;
    const out = typeof wk === "string" ? wk : null;
    olIsbnWorkCache.set(key, out);
    return out;
  } catch {
    olIsbnWorkCache.set(key, null);
    return null;
  }
}

function extractWikidataQid(raw: string): string | null {
  const s2 = String(raw || "").trim();
  const m = s2.match(/Q\d+/i);
  return m ? m[0].toUpperCase() : null;
}

async function openLibraryWorkToWikidataQid(workKey: string): Promise<string | null> {
  const wk = String(workKey || "").trim();
  if (!wk) return null;
  if (openLibraryWorkWikidataCache.has(wk)) return openLibraryWorkWikidataCache.get(wk)!;

  try {
    const url = `https://openlibrary.org${wk}.json`;
    const j = await fetchJson(url, 12000);

    const fromIdentifiers = Array.isArray(j?.identifiers?.wikidata) ? j.identifiers.wikidata : [];
    for (const v of fromIdentifiers) {
      const q = extractWikidataQid(String(v));
      if (q) {
        openLibraryWorkWikidataCache.set(wk, q);
        return q;
      }
    }

    const links = Array.isArray(j?.links) ? j.links : [];
    for (const l of links) {
      const q = extractWikidataQid(String(l?.url || ""));
      if (q) {
        openLibraryWorkWikidataCache.set(wk, q);
        return q;
      }
    }

    openLibraryWorkWikidataCache.set(wk, null);
    return null;
  } catch {
    openLibraryWorkWikidataCache.set(wk, null);
    return null;
  }
}

async function wikidataWorkQidByTitleAuthor(title: string, authors: string): Promise<string | null> {
  const t = String(title || "").trim();
  const a = String(authors || "").trim();
  if (!t) return null;

  const key = `${primaryAuthorKey(a)}|${titleTokenKey(t) || norm(t)}`;
  if (wikidataTitleAuthorCache.has(key)) return wikidataTitleAuthorCache.get(key)!;

  const authorNeedle = primaryAuthorKey(a);
  const authorLast = norm(authorLastName(pickPrimaryAuthor(a)));

  try {
    for (const lang of WIKIDATA_LANGS) {
      const params = new URLSearchParams();
      params.set("action", "wbsearchentities");
      params.set("format", "json");
      params.set("language", lang);
      params.set("type", "item");
      params.set("limit", "8");
      params.set("search", t);

      const url = `https://www.wikidata.org/w/api.php?${params.toString()}`;
      const j = await fetchJson(url, 12000, { Accept: "application/json" });
      const arr = Array.isArray(j?.search) ? j.search : [];
      if (!arr.length) continue;

      let best: { id: string; score: number } | null = null;
      for (const item of arr) {
        const id = extractWikidataQid(String(item?.id || ""));
        if (!id) continue;

        const label = norm(String(item?.label || ""));
        const desc = norm(String(item?.description || ""));
        const blob = `${label} ${desc}`;

        let score = 0;
        if (titleTokenKey(t) && label.includes(titleTokenKey(t).split(" ")[0] || "")) score += 2;
        if (desc.includes("novel") || desc.includes("book") || desc.includes("roman")) score += 2;
        if (authorNeedle && blob.includes(authorNeedle)) score += 3;
        if (authorLast && blob.includes(authorLast)) score += 2;

        if (!best || score > best.score) best = { id, score };
      }

      if (best && best.score >= 3) {
        wikidataTitleAuthorCache.set(key, best.id);
        return best.id;
      }
    }

    wikidataTitleAuthorCache.set(key, null);
    return null;
  } catch {
    wikidataTitleAuthorCache.set(key, null);
    return null;
  }
}

async function resolveCanonicalKey(workKey: string | null, title: string, authors: string): Promise<string | null> {
  if (workKey) {
    const qid = await openLibraryWorkToWikidataQid(workKey);
    if (qid) return `wd:${qid}`;
  }

  const qidByTitle = await wikidataWorkQidByTitleAuthor(title, authors);
  if (qidByTitle) return `wd:${qidByTitle}`;

  if (workKey) return `ol:${workKey}`;

  const ak = primaryAuthorKey(authors);
  const tk = titleTokenKey(title);
  if (tk) return `na:${ak}|${tk}`;

  return null;
}

type PreferenceSignals = {
  likedKeys: Set<string>;
  dislikedKeys: Set<string>;
};

async function loadPreferenceSignals(userId: number): Promise<PreferenceSignals> {
  try {
    const rows = await prisma.recommendationEvent.findMany({
      where: {
        userId,
        event: { in: ["pref_like", "pref_dislike"] },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: {
        workKey: true,
        event: true,
      },
    });

    const likedKeys = new Set<string>();
    const dislikedKeys = new Set<string>();
    const seen = new Set<string>();

    for (const r of rows) {
      const key = String(r.workKey || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      if (r.event === "pref_like") likedKeys.add(key);
      if (r.event === "pref_dislike") dislikedKeys.add(key);
    }

    return { likedKeys, dislikedKeys };
  } catch (e: any) {
    // Graceful fallback for environments where RecommendationEvent table is not migrated yet.
    if (e?.code === "P2021") {
      return { likedKeys: new Set<string>(), dislikedKeys: new Set<string>() };
    }
    throw e;
  }
}

function buildPreferenceKeys(
  resolvedCanonicalKey: string | null,
  resolvedWorkKey: string | null,
  authorKey: string,
  tKey: string,
  isbn: string
): string[] {
  const out = new Set<string>();
  if (resolvedCanonicalKey) out.add(resolvedCanonicalKey);
  if (resolvedWorkKey) out.add(`ol:${resolvedWorkKey}`);
  if (authorKey && tKey) out.add(`na:${authorKey}|${tKey}`);
  if (isbn) out.add(`isbn:${isbn}`);
  return Array.from(out);
}

function workKeyFromDoc(doc: OpenLibraryDoc): string | null {
  const k = doc?.key;
  if (typeof k === "string" && k.startsWith("/works/")) return k;
  return null;
}

function cacheSet(key: string, docs: OpenLibraryDoc[]) {
  if (openLibrarySearchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = openLibrarySearchCache.keys().next().value as string | undefined;
    if (oldestKey) openLibrarySearchCache.delete(oldestKey);
  }

  openLibrarySearchCache.set(key, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    docs,
  });
}

/** -----------------------------
 *  Profil ableiten aus Bibliothek
 *  ----------------------------- */
function computeProfile(entries: any[], minRating: number): Profile {
  const liked = entries.filter(
    (e) => e.status === "read" && typeof e.rating === "number" && (e.rating ?? 0) >= minRating
  );

  const subjWeights = new Map<string, number>();
  const authWeights = new Map<string, number>();

  for (const e of liked) {
    const rating = typeof e.rating === "number" ? e.rating : minRating;
    const w = clamp(rating, minRating, 10);

    const subjects = parseSubjects(e.subjects);
    for (const s of subjects) {
      const k = (s || "").trim();
      if (!k) continue;
      const factor = isGenericSubject(k) ? 0.15 : 1;
      subjWeights.set(k, (subjWeights.get(k) || 0) + w * factor);
    }

    const authors = (e.authors || "").split(",").map((x: string) => x.trim()).filter(Boolean);
    for (const a of authors) {
      authWeights.set(a, (authWeights.get(a) || 0) + w);
    }
  }

  const topSubjects = Array.from(subjWeights.entries())
    .map(([subject, weight]) => ({ subject, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);

  const topAuthors = Array.from(authWeights.entries())
    .map(([author, weight]) => ({ author, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);

  return { likedCount: liked.length, topSubjects, topAuthors };
}

/** -----------------------------
 *  Candidate gathering (OpenLibrary)
 *  ----------------------------- */
async function openLibraryWorkKeyByTitleAuthor(title: string, authors: string): Promise<string | null> {
  const t = String(title || "").trim();
  const a = String(authors || "").trim();
  if (!t) return null;

  const query = [t, a].filter(Boolean).join(" ");
  if (!query) return null;

  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", "6");
  params.set("fields", "key,title,author_name");

  try {
    const url = `https://openlibrary.org/search.json?${params.toString()}`;
    const j = await fetchJson(url, 12000);
    const docs = Array.isArray(j?.docs) ? (j.docs as OpenLibraryDoc[]) : [];

    const targetAuthor = primaryAuthorKey(authors);
    for (const d of docs) {
      const wk = workKeyFromDoc(d);
      if (!wk) continue;

      const candAuthors = authorsFromDoc(d);
      const candAuthor = primaryAuthorKey(candAuthors);
      if (targetAuthor && candAuthor && targetAuthor !== candAuthor) continue;

      const candTitle = String(d.title || "").trim();
      if (!candTitle) continue;
      if (!isTitleNearDuplicateSameAuthor(t, candTitle) && titleTokenKey(t) !== titleTokenKey(candTitle)) continue;

      return wk;
    }

    // fallback: first work key, even if fuzzy match was weak
    for (const d of docs) {
      const wk = workKeyFromDoc(d);
      if (wk) return wk;
    }
    return null;
  } catch {
    return null;
  }
}

async function openLibrarySearch(query: string, limit: number, debug: DebugInfo, type: string): Promise<OpenLibraryDoc[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("mode", "everything");
  params.set("limit", String(limit));
  params.set("fields", "title,author_name,isbn,subject,language,first_sentence,cover_i,edition_key,key");

  const url = `https://openlibrary.org/search.json?${params.toString()}`;

  const cached = openLibrarySearchCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    if (!Array.isArray(debug.openLibraryCalls)) debug.openLibraryCalls = [];
    debug.openLibraryCalls.push({ type, q: query, limit, got: cached.docs.length, cached: true });
    return cached.docs;
  }

  try {
    const j = await fetchJson(url, 15000);
    const docs = (j?.docs || []) as OpenLibraryDoc[];

    cacheSet(url, docs);

    if (!Array.isArray(debug.openLibraryCalls)) debug.openLibraryCalls = [];
    debug.openLibraryCalls.push({ type, q: query, limit, got: docs.length, cached: false });

    return docs;
  } catch (e: any) {
    if (!Array.isArray(debug.openLibraryCalls)) debug.openLibraryCalls = [];
    debug.openLibraryCalls.push({ type, q: query, limit, got: 0, error: e?.message ?? "search failed" });
    return [];
  }
}

function bestIsbnFromDoc(doc: OpenLibraryDoc): string | null {
  const isbns: string[] = Array.isArray(doc?.isbn) ? doc.isbn : [];
  const isbn13 = isbns.find((x) => typeof x === "string" && x.replace(/[^0-9]/g, "").length === 13);
  const isbn10 = isbns.find((x) => typeof x === "string" && x.replace(/[^0-9Xx]/g, "").length === 10);
  const pick = isbn13 || isbn10;
  return pick ? pick.replace(/[^0-9Xx]/g, "") : null;
}

function authorsFromDoc(doc: OpenLibraryDoc): string {
  const arr: string[] = Array.isArray(doc?.author_name) ? doc.author_name : [];
  return arr.slice(0, 3).join(", ");
}

function descriptionFromDoc(doc: OpenLibraryDoc): string | null {
  const fs = doc?.first_sentence;
  if (!fs) return null;

  if (typeof fs === "string") {
    const t = fs.trim();
    return t || null;
  }

  if (Array.isArray(fs)) {
    for (const item of fs) {
      if (typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object" && typeof item.value === "string" && item.value.trim()) return item.value.trim();
    }
    return null;
  }

  if (typeof fs === "object" && typeof fs.value === "string") {
    const t = fs.value.trim();
    return t || null;
  }

  return null;
}

function isGermanDoc(doc: OpenLibraryDoc): boolean {
  const langs = Array.isArray(doc.language) ? doc.language.map((x) => String(x).toLowerCase()) : [];
  if (
    langs.some(
      (l) =>
        l === "de" ||
        l === "ger" ||
        l === "deu" ||
        l.includes("/ger") ||
        l.includes("/deu") ||
        l.includes("deutsch")
    )
  ) {
    return true;
  }

  const title = String(doc.title || "");
  const firstSentence = descriptionFromDoc(doc) || "";
  return looksGerman(`${title} ${firstSentence}`.trim());
}

async function openLibraryDescriptionFromWorkKey(workKey: string | null): Promise<string | null> {
  const wk = String(workKey || "").trim();
  if (!wk) return null;

  if (openLibraryWorkDescriptionCache.has(wk)) {
    return openLibraryWorkDescriptionCache.get(wk)!;
  }

  try {
    const url = `https://openlibrary.org${wk}.json`;
    const j = await fetchJson(url, 12000);

    let out: string | null = null;
    if (typeof j?.description === "string") out = j.description.trim() || null;
    if (!out && typeof j?.description?.value === "string") out = String(j.description.value).trim() || null;

    openLibraryWorkDescriptionCache.set(wk, out);
    return out;
  } catch {
    openLibraryWorkDescriptionCache.set(wk, null);
    return null;
  }
}

async function wikidataDescriptionByCanonicalKey(canonicalKey: string | null): Promise<string | null> {
  const key = String(canonicalKey || "").trim();
  if (!key.startsWith("wd:Q")) return null;
  if (wikidataDescriptionCache.has(key)) return wikidataDescriptionCache.get(key)!;

  try {
    const qid = key.slice(3);
    const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
    const j = await fetchJson(url, 12000, { Accept: "application/json" });
    const entity = j?.entities?.[qid];
    const desc = entity?.descriptions || {};

    const preferred = ["de", "en", "es", "fr"];
    for (const lang of preferred) {
      const v = desc?.[lang]?.value;
      if (typeof v === "string" && v.trim()) {
        const out = v.trim();
        wikidataDescriptionCache.set(key, out);
        return out;
      }
    }

    const any = Object.values(desc || {}).find((x: any) => typeof x?.value === "string" && x.value.trim());
    const out = typeof (any as any)?.value === "string" ? String((any as any).value).trim() : null;
    wikidataDescriptionCache.set(key, out);
    return out;
  } catch {
    wikidataDescriptionCache.set(key, null);
    return null;
  }
}

function looksGerman(text: string): boolean {
  const raw = String(text || "").toLowerCase();
  if (!raw.trim()) return false;
  if (/[äöüß]/.test(raw)) return true;

  const words = new Set(norm(raw).split(" ").filter(Boolean));
  const hints = [
    "und",
    "mit",
    "der",
    "die",
    "das",
    "ein",
    "eine",
    "ist",
    "nicht",
    "auch",
    "wird",
    "zum",
    "zur",
    "den",
    "dem",
  ];

  let hits = 0;
  for (const h of hints) {
    if (words.has(h)) hits++;
  }

  return hits >= 2;
}

function synthesizeDescription(rec: Recommendation): string {
  const motifFromReasons = rec.reasons
    .filter((r) => r.label === "Story-Ähnlichkeit")
    .flatMap((r) => {
      const raw = String(r.detail || "");
      return Object.keys(MOTIF_LABEL_DE).filter(
        (k) => raw.toLowerCase().includes(String(MOTIF_LABEL_DE[k] || "").toLowerCase()) || raw.toLowerCase().includes(k.replace(/_/g, " "))
      );
    });

  const motifKey = motifFromReasons[0] || null;
  const motifLabel = motifKey ? MOTIF_LABEL_DE[motifKey] : null;
  const subjects = (rec.subjects || []).filter((x) => !isGenericSubject(x)).slice(0, 3);

  if (motifLabel && subjects.length >= 2) {
    return `Im Zentrum stehen ${subjects.join(", ")}. Der Ton geht klar in Richtung ${motifLabel.toLowerCase()}.`;
  }

  if (motifLabel) {
    return `Die Geschichte setzt vor allem auf ${motifLabel.toLowerCase()} und starke Figurenbeziehungen.`;
  }

  if (subjects.length > 0) {
    return `Thematisch dreht sich das Buch vor allem um ${subjects.join(", ")}.`;
  }

  return "Eine charaktergetriebene Erzaehlung mit starker Beziehungsebene.";
}

function subjectsFromDoc(doc: OpenLibraryDoc): string[] {
  const arr: string[] = Array.isArray(doc?.subject) ? doc.subject : [];
  return arr.slice(0, 12);
}

/** -----------------------------
 *  Scoring
 *  ----------------------------- */
function scoreCandidate(doc: OpenLibraryDoc, profile: Profile, storyProfile: StoryProfile) {
  const docSubjects: string[] = subjectsFromDoc(doc);
  const docAuthors = (Array.isArray(doc?.author_name) ? doc.author_name : []) as string[];

  const topSubj = profile.topSubjects.map((s) => s.subject);
  const topAuth = profile.topAuthors.map((a) => a.author);

  const normalizedSubjects = docSubjects.map((s) => norm(s));
  const subjectSet = new Set(normalizedSubjects);
  const subjHits: string[] = [];
  let topicRaw = 0;
  for (const s of topSubj) {
    const ns = norm(s);
    if (!subjectSet.has(ns)) continue;
    subjHits.push(s);
    topicRaw += isGenericSubject(s) ? 0.25 : 1;
  }

  const docAuthNorm = new Set(docAuthors.map((a) => norm(a)));
  const authHit = topAuth.find((a) => docAuthNorm.has(norm(a)));

  const storyInput = [String(doc.title || ""), docSubjects.join(" ")].join(" ");
  const candidateStoryTerms = Array.from(new Set(extractStoryTerms(storyInput)));

  let storyRaw = 0;
  const storyHits: { term: string; weight: number }[] = [];
  for (const t of candidateStoryTerms) {
    const w = storyProfile.weights.get(t);
    if (!w) continue;
    storyRaw += w;
    storyHits.push({ term: t, weight: w });
  }

  const candidateMotifs = extractMotifsFromText(storyInput);
  const motifHits: { motif: string; weight: number }[] = [];
  for (const m of candidateMotifs) {
    const w = storyProfile.motifWeights.get(m);
    if (!w) continue;
    storyRaw += w * 1.5;
    motifHits.push({ motif: m, weight: w });
  }

  storyHits.sort((a, b) => b.weight - a.weight);
  motifHits.sort((a, b) => b.weight - a.weight);

  const storyNorm = Math.min(1, storyRaw / storyProfile.normDenominator);
  const topicNorm = topSubj.length ? Math.min(1, topicRaw / Math.min(3, topSubj.length)) : 0;
  const authorNorm = authHit ? 1 : 0;

  const score = STORY_WEIGHT * storyNorm + TOPIC_WEIGHT * topicNorm + AUTHOR_WEIGHT * authorNorm;

  const reasons: Reason[] = [];
  if (motifHits.length > 0) {
    reasons.push({
      label: "Story-Ähnlichkeit",
      detail: `ähnlicher Erzählkern: ${motifHits.slice(0, 2).map((x) => `„${MOTIF_LABEL_DE[x.motif] || x.motif.replace(/_/g, " ")}“`).join(", ")}`,
    });
  } else if (storyHits.length > 0) {
    reasons.push({
      label: "Story-Ähnlichkeit",
      detail: `ähnliche Schwerpunkte: ${storyHits.slice(0, 2).map((x) => `„${x.term}“`).join(", ")}`,
    });
  }

  if (subjHits.length) {
    reasons.push({
      label: "Themen-Überschneidung",
      detail: `passt zu „${subjHits[0]}“ (kommt oft in deinen Top-Büchern vor)`,
    });
  }

  if (authHit) {
    reasons.push({
      label: "Autor-Ähnlichkeit",
      detail: "Autor:in taucht in deinem Profil auf (niedrig gewichtet)",
    });
  }

  return { score, reasons: reasons.slice(0, 3) };
}

/** -----------------------------
 *  Dedup / Owned keys
 *  ----------------------------- */
async function buildOwnedKeys(entries: any[], debug: DebugInfo) {
  const ownedIsbn = new Set<string>();
  const ownedCanonical = new Set<string>();
  const ownedTitlesByPrimaryAuthor = new Map<string, string[]>();
  const ownedAuthorKeys = new Set<string>();

  const normalizedIsbns = uniq(
    entries
      .map((e) => String(e?.isbn || "").trim())
      .filter(Boolean)
  );

  for (const isbn of normalizedIsbns) {
    ownedIsbn.add(isbn);
  }

  for (const e of entries) {
    const title = String(e?.title || "").trim();
    const authorKey = primaryAuthorKey(String(e?.authors || ""));
    if (authorKey) ownedAuthorKeys.add(authorKey);
    const tKey = titleTokenKey(title);
    if (!tKey) continue;

    ownedCanonical.add(`${authorKey}|${tKey}`);
    if (!authorKey) continue;

    const arr = ownedTitlesByPrimaryAuthor.get(authorKey) ?? [];
    arr.push(title);
    ownedTitlesByPrimaryAuthor.set(authorKey, arr);
  }

  const ownedWork = new Set<string>();

  const byIsbn = await pMapLimit(normalizedIsbns, OWNED_WORK_LOOKUP_CONCURRENCY, async (isbn) => {
    const wk = await openLibraryIsbnToWorkKey(isbn);
    return { isbn, wk };
  });

  let succeeded = 0;
  const wkByIsbn = new Map<string, string | null>();
  for (const r of byIsbn) {
    wkByIsbn.set(r.isbn, r.wk);
    if (r.wk) {
      succeeded++;
      ownedWork.add(r.wk);
    }
  }

  let fallbackTried = 0;
  let fallbackHit = 0;

  const fallbackWorkKeys = await pMapLimit(entries, 4, async (e) => {
    const isbn = String(e?.isbn || "").trim();
    const title = String(e?.title || "").trim();
    const authors = String(e?.authors || "").trim();

    const fromIsbn = isbn ? wkByIsbn.get(isbn) ?? null : null;
    if (fromIsbn) return fromIsbn;

    if (!title) return null;
    fallbackTried++;
    const wk = await openLibraryWorkKeyByTitleAuthor(title, authors);
    if (wk) fallbackHit++;
    return wk;
  });

  for (const wk of fallbackWorkKeys) {
    if (wk) ownedWork.add(wk);
  }

  debug.ownedWorkLookupsTried = normalizedIsbns.length;
  debug.ownedWorkLookupsSucceeded = succeeded;
  debug.ownedWorkTitleFallbackTried = fallbackTried;
  debug.ownedWorkTitleFallbackHit = fallbackHit;
  debug.ownedWorkKeysCount = ownedWork.size;

  return { ownedIsbn, ownedWork, ownedCanonical, ownedTitlesByPrimaryAuthor, ownedAuthorKeys };
}

/** -----------------------------
 *  Handler
 *  ----------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startedAt = Date.now();
  try {
    const user = await getSessionUser(req);
    if (!user) return jsonErr(res, 401, "Not authenticated");

    const requestedLimit = parseInt(String(req.query.limit ?? "15"), 10) || 15;
    const limit = requestedLimit >= 20 ? 20 : 15;
    const minRating = clamp(parseInt(String(req.query.minRating ?? "4"), 10) || 4, 0, 10);
    const seedMode = String(req.query.seedMode ?? "liked");
    const seedIdsRaw = String(req.query.seedEntryIds ?? "").trim();
    const selectedSeedIds = new Set<number>(
      seedIdsRaw
        ? seedIdsRaw
            .split(",")
            .map((x) => Number(String(x).trim()))
            .filter((x) => Number.isFinite(x) && x > 0)
        : []
    );
    const debugMode = String(req.query.debug ?? "") === "1";

    const debug: DebugInfo = {};
    debug.limit = limit;
    debug.minRating = minRating;
    debug.seedMode = seedMode;

    const entries = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      take: 500,
      select: {
        id: true,
        isbn: true,
        title: true,
        authors: true,
        status: true,
        rating: true,
        notes: true,
        description: true,
        subjects: true,
      },
    });

    debug.entryCount = entries.length;

    const seedEntries = selectedSeedIds.size > 0 ? entries.filter((e) => selectedSeedIds.has(Number(e.id))) : entries;

    const profile = computeProfile(seedEntries, minRating);
    const storyProfile = buildStoryProfile(seedEntries, minRating);
    debug.selectedSeedCount = selectedSeedIds.size;
    debug.seedPoolCount = seedEntries.length;
    debug.likedCount = profile.likedCount;
    debug.topSubjectsCount = profile.topSubjects.length;
    debug.topAuthorsCount = profile.topAuthors.length;
    debug.storyTermsCount = storyProfile.topTerms.length;
    debug.storyMotifsCount = storyProfile.topMotifs.length;

    if (profile.likedCount === 0) {
      debug.totalMs = Date.now() - startedAt;
      return jsonOk(res, {
        user,
        profile,
        recommendations: [],
        debug: debugMode ? debug : undefined,
      });
    }

    const { ownedIsbn, ownedWork, ownedCanonical, ownedTitlesByPrimaryAuthor, ownedAuthorKeys } = await buildOwnedKeys(entries, debug);
    debug.ownedWorkCanonCount = ownedWork.size;

    const ownedCanonicalResolved = new Set<string>();
    for (const e of entries) {
      const et = String(e?.title || "").trim();
      const ea = String(e?.authors || "").trim();
      const ei = String(e?.isbn || "").trim();
      let ewk: string | null = null;
      if (ei) ewk = await openLibraryIsbnToWorkKey(ei);
      const ckey = await resolveCanonicalKey(ewk, et, ea);
      if (ckey) ownedCanonicalResolved.add(ckey);
    }

    const preferenceSignals = await loadPreferenceSignals(user.id);

    const topSubjects = profile.topSubjects.map((x) => x.subject);
    const topAuthors = profile.topAuthors.map((x) => x.author);

    const docs: OpenLibraryDoc[] = [];
    debug.openLibraryCalls = [];

    const subjectLimit = clamp(Math.ceil(limit), 10, 40);
    const authorLimit = clamp(Math.ceil(limit * 0.6), 8, 25);

    const subjectQueriesDe = topSubjects.map((s) => ({ q: `subject:"${s}" language:ger`, type: "subject_de" as const, l: subjectLimit }));
    const authorQueriesDe = topAuthors.map((a) => ({ q: `author:"${a}" language:ger`, type: "author_de" as const, l: authorLimit }));
    const subjectQueries = topSubjects.map((s) => ({ q: `subject:"${s}"`, type: "subject" as const, l: subjectLimit }));
    const authorQueries = topAuthors.map((a) => ({ q: `author:"${a}"`, type: "author" as const, l: authorLimit }));
    const allQueries = [...subjectQueriesDe, ...authorQueriesDe, ...subjectQueries, ...authorQueries];

    const queryResults = await pMapLimit(allQueries, OPENLIBRARY_QUERY_CONCURRENCY, async (entry) => {
      return openLibrarySearch(entry.q, entry.l, debug, entry.type);
    });

    for (const chunk of queryResults) {
      docs.push(...chunk);
    }

    debug.docsTotal = docs.length;

    const scoredGerman: Array<{ rec: Recommendation; workKey: string | null }> = [];
    const scoredOther: Array<{ rec: Recommendation; workKey: string | null }> = [];

    for (const doc of docs) {
      const isbn = bestIsbnFromDoc(doc);
      if (!isbn) continue;

      const title = String(doc?.title || "").trim();
      if (!title) continue;

      const authors = authorsFromDoc(doc);
      const subjects = subjectsFromDoc(doc);

      const { score, reasons } = scoreCandidate(doc, profile, storyProfile);
      if (score <= 0) continue;

      const wk = workKeyFromDoc(doc);
      const german = isGermanDoc(doc);

      const target = german ? scoredGerman : scoredOther;
      target.push({
        workKey: wk,
        rec: {
          recId: `seed:${isbn}`,
          workKey: wk,
          isbn,
          title,
          authors,
          coverUrl: coverFromIsbn(isbn),
          description: descriptionFromDoc(doc),
          score: score + (german ? GERMAN_SCORE_BONUS : 0),
          reasons,
          subjects,
        },
      });
    }

    scoredGerman.sort((a, b) => b.rec.score - a.rec.score);
    scoredOther.sort((a, b) => b.rec.score - a.rec.score);

    const scored = scoredGerman.length >= limit ? scoredGerman : [...scoredGerman, ...scoredOther];

    debug.candidatesSeen = scored.length;
    debug.candidatesWithIsbn = scored.length;
    debug.candidatesGerman = scoredGerman.length;
    debug.candidatesNonGerman = scoredOther.length;

    debug.candidateWorkLookupsTried = 0;
    debug.candidateWorkLookupsSucceeded = 0;
    debug.candidateWorkCanonLookupsTried = 0;
    debug.candidateWorkCanonLookupsSucceeded = 0;

    debug.editionLookupsTried = 0;
    debug.editionLookupsSucceeded = 0;
    debug.isbnResolvedViaEditionKey = 0;

    const out: Recommendation[] = [];

    let afterOwnedIsbn = 0;
    let afterOwnedWork = 0;
    let afterTitle = 0;
    let droppedByAuthorLimit = 0;
    let candidateWorkTitleFallbackTried = 0;
    let candidateWorkTitleFallbackHit = 0;
    let candidateWorkIsbnVerificationTried = 0;
    let candidateWorkIsbnVerificationHit = 0;
    let candidateCanonicalResolvedHit = 0;
    let droppedByPreferenceDislike = 0;
    let boostedByPreferenceLike = 0;

    const seenIsbn = new Set<string>();
    const seenWorkOrIsbn = new Set<string>();
    const seenCanonical = new Set<string>();
    const seenTitlesByPrimaryAuthor = new Map<string, string[]>();
    const perAuthorCount = new Map<string, number>();
    const candidateWorkByTitleCache = new Map<string, string | null>();

    function fallbackCanonicalKey(r: Recommendation) {
      const authorKey = primaryAuthorKey(r.authors);
      const tKey = titleTokenKey(r.title);
      if (tKey) return `na:${authorKey}|${tKey}`;

      const aLast = authorLastName(pickPrimaryAuthor(r.authors));
      return `na:${norm(r.title)}|${norm(aLast)}`;
    }

    for (const item of scored) {
      if (out.length >= limit) break;

      const r: Recommendation = { ...item.rec, recId: "", workKey: item.workKey };
      const wk = item.workKey;
      const authorKey = primaryAuthorKey(r.authors);
      const tKey = titleTokenKey(r.title);
      const strictOwnedKey = `${authorKey}|${tKey}`;

      let resolvedWorkKey: string | null = wk;
      if (!resolvedWorkKey) {
        const cacheKey = `${authorKey}|${tKey || norm(r.title)}`;
        if (candidateWorkByTitleCache.has(cacheKey)) {
          resolvedWorkKey = candidateWorkByTitleCache.get(cacheKey) ?? null;
        } else {
          candidateWorkTitleFallbackTried++;
          resolvedWorkKey = await openLibraryWorkKeyByTitleAuthor(r.title, r.authors);
          if (resolvedWorkKey) candidateWorkTitleFallbackHit++;
          candidateWorkByTitleCache.set(cacheKey, resolvedWorkKey ?? null);
        }
      }

      // For authors already in library, verify work key via ISBN to catch cross-language same-work variants.
      if (authorKey && ownedAuthorKeys.has(authorKey)) {
        candidateWorkIsbnVerificationTried++;
        const isbnVerifiedWorkKey = await openLibraryIsbnToWorkKey(r.isbn);
        if (isbnVerifiedWorkKey) {
          candidateWorkIsbnVerificationHit++;
          resolvedWorkKey = isbnVerifiedWorkKey;
        }
      }

      let resolvedCanonicalKey: string | null = null;
      const needsOwnedCanonicalCheck = authorKey && ownedAuthorKeys.has(authorKey);
      if (needsOwnedCanonicalCheck || !resolvedWorkKey) {
        resolvedCanonicalKey = await resolveCanonicalKey(resolvedWorkKey, r.title, r.authors);
        if (resolvedCanonicalKey) {
          candidateCanonicalResolvedHit++;
          if (ownedCanonicalResolved.has(resolvedCanonicalKey)) continue;
        }
      }

      const preferenceKeys = buildPreferenceKeys(
        resolvedCanonicalKey,
        resolvedWorkKey,
        authorKey,
        tKey,
        r.isbn
      );

      if (preferenceKeys.some((k) => preferenceSignals.dislikedKeys.has(k))) {
        droppedByPreferenceDislike++;
        continue;
      }

      if (preferenceKeys.some((k) => preferenceSignals.likedKeys.has(k))) {
        boostedByPreferenceLike++;
        r.score += 8;
        r.reasons = [
          { label: "Deine Präferenz", detail: "passt zu mir (vorher markiert)" },
          ...r.reasons,
        ].slice(0, 3);
      }

      if (ownedIsbn.has(r.isbn)) continue;
      if (seenIsbn.has(r.isbn)) continue;
      if (tKey && ownedCanonical.has(strictOwnedKey)) continue;

      if (authorKey) {
        const ownedTitles = ownedTitlesByPrimaryAuthor.get(authorKey) ?? [];
        if (ownedTitles.some((ownedTitle) => isTitleNearDuplicateSameAuthor(r.title, ownedTitle))) continue;
      }

      afterOwnedIsbn++;

      if (resolvedWorkKey && ownedWork.has(resolvedWorkKey)) continue;
      afterOwnedWork++;

      const workOrIsbnKey = resolvedWorkKey ? `wk:${resolvedWorkKey}` : `isbn:${r.isbn}`;
      if (seenWorkOrIsbn.has(workOrIsbnKey)) continue;
      seenWorkOrIsbn.add(workOrIsbnKey);

      if (authorKey) {
        const seenTitles = seenTitlesByPrimaryAuthor.get(authorKey) ?? [];
        if (seenTitles.some((seenTitle) => isTitleNearDuplicateSameAuthor(r.title, seenTitle))) continue;
      }

      const ck = resolvedCanonicalKey ?? (resolvedWorkKey ? `wk:${resolvedWorkKey}` : fallbackCanonicalKey(r));
      if (seenCanonical.has(ck)) continue;
      seenCanonical.add(ck);

      if (authorKey) {
        const cur = perAuthorCount.get(authorKey) ?? 0;
        if (cur >= MAX_RECS_PER_PRIMARY_AUTHOR) {
          droppedByAuthorLimit++;
          continue;
        }
        perAuthorCount.set(authorKey, cur + 1);
      }

      if (authorKey) {
        const seenTitles = seenTitlesByPrimaryAuthor.get(authorKey) ?? [];
        seenTitles.push(r.title);
        seenTitlesByPrimaryAuthor.set(authorKey, seenTitles);
      }

      afterTitle++;
      seenIsbn.add(r.isbn);
      r.workKey = resolvedWorkKey;
      r.recId = resolvedCanonicalKey || (resolvedWorkKey ? `wk:${resolvedWorkKey}` : `isbn:${r.isbn}`);
      out.push(r);
    }

    const missingDescIdx: number[] = [];
    for (let i = 0; i < out.length; i++) {
      if (!out[i].description && out[i].workKey) missingDescIdx.push(i);
    }

    const descResults = await pMapLimit(missingDescIdx, 4, async (idx) => {
      const key = out[idx].workKey || null;
      return openLibraryDescriptionFromWorkKey(key);
    });

    for (let i = 0; i < missingDescIdx.length; i++) {
      const idx = missingDescIdx[i];
      const d = descResults[i];
      if (d) out[idx].description = d;
    }

    // 2nd fallback: Wikidata short description via canonical key (wd:Q...)
    const missingAfterOl = out
      .map((x, idx) => ({ x, idx }))
      .filter(({ x }) => !x.description && !!x.recId)
      .map(({ idx }) => idx);

    const wdDescResults = await pMapLimit(missingAfterOl, 4, async (idx) => {
      return wikidataDescriptionByCanonicalKey(out[idx].recId || null);
    });

    for (let i = 0; i < missingAfterOl.length; i++) {
      const idx = missingAfterOl[i];
      const d = wdDescResults[i];
      if (d) out[idx].description = d;
    }

    // Final fallback: always provide concise German description in UI.
    for (const rec of out) {
      const desc = String(rec.description || "").trim();
      if (!desc || !looksGerman(desc)) {
        rec.description = synthesizeDescription(rec);
      } else {
        rec.description = desc.slice(0, 700);
      }
    }

    debug.candidatesAfterOwnedIsbnFilter = afterOwnedIsbn;
    debug.candidatesAfterOwnedWorkFilter = afterOwnedWork;
    debug.candidatesAfterTitleFilter = afterTitle;

    debug.uniqueByWorkOrIsbn = seenWorkOrIsbn.size;
    debug.uniqueByCanonicalOrWorkOrIsbn = seenCanonical.size;

    debug.candidatesAfterOwnedCanonicalFilter = afterTitle;
    debug.profileSourceCount = profile.likedCount;
    debug.readCount = entries.filter((e) => e.status === "read").length;
    debug.diversifiedDroppedByAuthor = droppedByAuthorLimit;
    debug.candidateWorkTitleFallbackTried = candidateWorkTitleFallbackTried;
    debug.candidateWorkTitleFallbackHit = candidateWorkTitleFallbackHit;
    debug.candidateWorkIsbnVerificationTried = candidateWorkIsbnVerificationTried;
    debug.candidateWorkIsbnVerificationHit = candidateWorkIsbnVerificationHit;
    debug.candidateCanonicalResolvedHit = candidateCanonicalResolvedHit;
    debug.ownedCanonicalResolvedCount = ownedCanonicalResolved.size;
    debug.preferenceLikedCount = preferenceSignals.likedKeys.size;
    debug.preferenceDislikedCount = preferenceSignals.dislikedKeys.size;
    debug.droppedByPreferenceDislike = droppedByPreferenceDislike;
    debug.boostedByPreferenceLike = boostedByPreferenceLike;
    debug.totalMs = Date.now() - startedAt;

    return jsonOk(res, {
      user,
      profile,
      recommendations: out,
      debug: debugMode ? debug : undefined,
    });
  } catch (e: any) {
    return jsonErr(res, 500, e?.message || e);
  }
}
