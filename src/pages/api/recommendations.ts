import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Reason = { label: string; detail: string };

type Recommendation = {
  isbn: string;
  title: string;
  authors: string;
  coverUrl?: string | null;
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
};

type OpenLibrarySearchCacheEntry = {
  expiresAt: number;
  docs: OpenLibraryDoc[];
};

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 120;
const OPENLIBRARY_QUERY_CONCURRENCY = 4;
const OWNED_WORK_LOOKUP_CONCURRENCY = 8;

const openLibrarySearchCache = new Map<string, OpenLibrarySearchCacheEntry>();

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

    const subjects: string[] = Array.isArray(e.subjects) ? e.subjects : [];
    for (const s of subjects) {
      const k = (s || "").trim();
      if (!k) continue;
      subjWeights.set(k, (subjWeights.get(k) || 0) + w);
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
async function openLibrarySearch(query: string, limit: number, debug: DebugInfo, type: string): Promise<OpenLibraryDoc[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("mode", "everything");
  params.set("limit", String(limit));
  params.set("fields", "title,author_name,isbn,subject,cover_i,edition_key,key");

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

function subjectsFromDoc(doc: OpenLibraryDoc): string[] {
  const arr: string[] = Array.isArray(doc?.subject) ? doc.subject : [];
  return arr.slice(0, 12);
}

/** -----------------------------
 *  Scoring
 *  ----------------------------- */
function scoreCandidate(doc: OpenLibraryDoc, profile: Profile) {
  const docSubjects: string[] = subjectsFromDoc(doc);
  const docAuthors = (Array.isArray(doc?.author_name) ? doc.author_name : []) as string[];

  const topSubj = profile.topSubjects.map((s) => s.subject);
  const topAuth = profile.topAuthors.map((a) => a.author);

  const set = new Set(docSubjects.map((s) => norm(s)));
  const subjHits: string[] = [];
  let score = 0;

  for (const s of topSubj) {
    if (set.has(norm(s))) {
      score += 5;
      subjHits.push(s);
    }
  }

  const docAuthNorm = new Set(docAuthors.map((a) => norm(a)));
  const authHit = topAuth.find((a) => docAuthNorm.has(norm(a)));
  if (authHit) score += 7;

  score += Math.min(3, docSubjects.length / 6);

  const reasons: Reason[] = [];
  if (subjHits.length) {
    reasons.push({
      label: "Themen-Überschneidung",
      detail: `passt zu „${subjHits[0]}“ (kommt oft in deinen Top-Büchern vor)`,
    });
    if (subjHits.length > 1) {
      reasons.push({
        label: "Mehr davon",
        detail: `auch verbunden mit „${subjHits[1]}“`,
      });
    }
  }
  if (authHit) {
    reasons.push({
      label: "Autor-Ähnlichkeit",
      detail: "Autor:in taucht in deinem Profil stark auf",
    });
  }

  return { score, reasons };
}

/** -----------------------------
 *  Dedup / Owned keys
 *  ----------------------------- */
async function buildOwnedKeys(entries: any[], debug: DebugInfo) {
  const ownedIsbn = new Set<string>();
  const normalizedIsbns = uniq(
    entries
      .map((e) => String(e?.isbn || "").trim())
      .filter(Boolean)
  );

  for (const isbn of normalizedIsbns) {
    ownedIsbn.add(isbn);
  }

  const ownedWork = new Set<string>();
  let succeeded = 0;

  const results = await pMapLimit(normalizedIsbns, OWNED_WORK_LOOKUP_CONCURRENCY, async (isbn) => {
    return openLibraryIsbnToWorkKey(isbn);
  });

  for (const wk of results) {
    if (!wk) continue;
    succeeded++;
    ownedWork.add(wk);
  }

  debug.ownedWorkLookupsTried = normalizedIsbns.length;
  debug.ownedWorkLookupsSucceeded = succeeded;
  debug.ownedWorkKeysCount = ownedWork.size;

  return { ownedIsbn, ownedWork };
}

/** -----------------------------
 *  Handler
 *  ----------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startedAt = Date.now();
  try {
    const user = await getSessionUser(req);
    if (!user) return jsonErr(res, 401, "Not authenticated");

    const limit = clamp(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1, 50);
    const minRating = clamp(parseInt(String(req.query.minRating ?? "4"), 10) || 4, 0, 10);
    const seedMode = String(req.query.seedMode ?? "liked");
    const debugMode = String(req.query.debug ?? "") === "1";

    const debug: DebugInfo = {};
    debug.limit = limit;
    debug.minRating = minRating;
    debug.seedMode = seedMode;

    const entries = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      take: 500,
      select: {
        isbn: true,
        title: true,
        authors: true,
        status: true,
        rating: true,
        subjects: true,
      },
    });

    debug.entryCount = entries.length;

    const profile = computeProfile(entries, minRating);
    debug.likedCount = profile.likedCount;
    debug.topSubjectsCount = profile.topSubjects.length;
    debug.topAuthorsCount = profile.topAuthors.length;

    if (profile.likedCount === 0) {
      debug.totalMs = Date.now() - startedAt;
      return jsonOk(res, {
        user,
        profile,
        recommendations: [],
        debug: debugMode ? debug : undefined,
      });
    }

    const { ownedIsbn, ownedWork } = await buildOwnedKeys(entries, debug);
    debug.ownedWorkCanonCount = ownedWork.size;

    const topSubjects = profile.topSubjects.map((x) => x.subject);
    const topAuthors = profile.topAuthors.map((x) => x.author);

    const docs: OpenLibraryDoc[] = [];
    debug.openLibraryCalls = [];

    const subjectLimit = clamp(Math.ceil(limit), 10, 40);
    const authorLimit = clamp(Math.ceil(limit * 0.6), 8, 25);

    const subjectQueries = topSubjects.map((s) => ({ q: `subject:"${s}"`, type: "subject" as const, l: subjectLimit }));
    const authorQueries = topAuthors.map((a) => ({ q: `author:"${a}"`, type: "author" as const, l: authorLimit }));
    const allQueries = [...subjectQueries, ...authorQueries];

    const queryResults = await pMapLimit(allQueries, OPENLIBRARY_QUERY_CONCURRENCY, async (entry) => {
      return openLibrarySearch(entry.q, entry.l, debug, entry.type);
    });

    for (const chunk of queryResults) {
      docs.push(...chunk);
    }

    debug.docsTotal = docs.length;

    const scored: Array<{ rec: Recommendation; workKey: string | null }> = [];

    for (const doc of docs) {
      const isbn = bestIsbnFromDoc(doc);
      if (!isbn) continue;

      const title = String(doc?.title || "").trim();
      if (!title) continue;

      const authors = authorsFromDoc(doc);
      const subjects = subjectsFromDoc(doc);

      const { score, reasons } = scoreCandidate(doc, profile);
      if (score <= 0) continue;

      const wk = workKeyFromDoc(doc);

      scored.push({
        workKey: wk,
        rec: {
          isbn,
          title,
          authors,
          coverUrl: coverFromIsbn(isbn),
          score,
          reasons,
          subjects,
        },
      });
    }

    scored.sort((a, b) => b.rec.score - a.rec.score);

    debug.candidatesSeen = scored.length;
    debug.candidatesWithIsbn = scored.length;

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

    const seenIsbn = new Set<string>();
    const seenWorkOrIsbn = new Set<string>();
    const seenCanonical = new Set<string>();

    function cheapCanonicalKey(r: Recommendation) {
      const aLast = authorLastName(pickPrimaryAuthor(r.authors));
      return `na:${norm(r.title)}|${norm(aLast)}`;
    }

    for (const item of scored) {
      if (out.length >= limit) break;

      const r = item.rec;
      const wk = item.workKey;

      if (ownedIsbn.has(r.isbn)) continue;
      if (seenIsbn.has(r.isbn)) continue;
      afterOwnedIsbn++;

      if (wk && ownedWork.has(wk)) continue;
      afterOwnedWork++;

      const workOrIsbnKey = wk ? `wk:${wk}` : `isbn:${r.isbn}`;
      if (seenWorkOrIsbn.has(workOrIsbnKey)) continue;
      seenWorkOrIsbn.add(workOrIsbnKey);

      const ck = wk ? `wk:${wk}` : cheapCanonicalKey(r);
      if (seenCanonical.has(ck)) continue;
      seenCanonical.add(ck);

      afterTitle++;
      seenIsbn.add(r.isbn);
      out.push(r);
    }

    debug.candidatesAfterOwnedIsbnFilter = afterOwnedIsbn;
    debug.candidatesAfterOwnedWorkFilter = afterOwnedWork;
    debug.candidatesAfterTitleFilter = afterTitle;

    debug.uniqueByWorkOrIsbn = seenWorkOrIsbn.size;
    debug.uniqueByCanonicalOrWorkOrIsbn = seenCanonical.size;

    debug.candidatesAfterOwnedCanonicalFilter = afterTitle;
    debug.profileSourceCount = profile.likedCount;
    debug.readCount = entries.filter((e) => e.status === "read").length;
    debug.diversifiedDroppedByAuthor = 0;
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
