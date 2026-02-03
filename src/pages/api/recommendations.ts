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
const MAX_RECS_PER_PRIMARY_AUTHOR = 1;

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
  const ownedCanonical = new Set<string>();
  const ownedTitlesByPrimaryAuthor = new Map<string, string[]>();

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

  return { ownedIsbn, ownedWork, ownedCanonical, ownedTitlesByPrimaryAuthor };
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

    const { ownedIsbn, ownedWork, ownedCanonical, ownedTitlesByPrimaryAuthor } = await buildOwnedKeys(entries, debug);
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
    let droppedByAuthorLimit = 0;

    const seenIsbn = new Set<string>();
    const seenWorkOrIsbn = new Set<string>();
    const seenCanonical = new Set<string>();
    const seenTitlesByPrimaryAuthor = new Map<string, string[]>();
    const perAuthorCount = new Map<string, number>();

    function fallbackCanonicalKey(r: Recommendation) {
      const authorKey = primaryAuthorKey(r.authors);
      const tKey = titleTokenKey(r.title);
      if (tKey) return `na:${authorKey}|${tKey}`;

      const aLast = authorLastName(pickPrimaryAuthor(r.authors));
      return `na:${norm(r.title)}|${norm(aLast)}`;
    }

    for (const item of scored) {
      if (out.length >= limit) break;

      const r = item.rec;
      const wk = item.workKey;
      const authorKey = primaryAuthorKey(r.authors);
      const tKey = titleTokenKey(r.title);
      const strictOwnedKey = `${authorKey}|${tKey}`;

      if (ownedIsbn.has(r.isbn)) continue;
      if (seenIsbn.has(r.isbn)) continue;
      if (tKey && ownedCanonical.has(strictOwnedKey)) continue;

      if (authorKey) {
        const ownedTitles = ownedTitlesByPrimaryAuthor.get(authorKey) ?? [];
        if (ownedTitles.some((ownedTitle) => isTitleNearDuplicateSameAuthor(r.title, ownedTitle))) continue;
      }

      afterOwnedIsbn++;

      if (wk && ownedWork.has(wk)) continue;
      afterOwnedWork++;

      const workOrIsbnKey = wk ? `wk:${wk}` : `isbn:${r.isbn}`;
      if (seenWorkOrIsbn.has(workOrIsbnKey)) continue;
      seenWorkOrIsbn.add(workOrIsbnKey);

      if (authorKey) {
        const seenTitles = seenTitlesByPrimaryAuthor.get(authorKey) ?? [];
        if (seenTitles.some((seenTitle) => isTitleNearDuplicateSameAuthor(r.title, seenTitle))) continue;
      }

      const ck = wk ? `wk:${wk}` : fallbackCanonicalKey(r);
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
    debug.diversifiedDroppedByAuthor = droppedByAuthorLimit;
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
