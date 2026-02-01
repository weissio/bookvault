import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import type { Prisma } from "@prisma/client";

type Reason = { label: string; detail?: string };

type RecItem = {
  isbn: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  score: number;
  reasons: Reason[];
  subjects: string[];
};

type DebugStats = {
  seedMode: string;
  minRating: number;
  limit: number;

  entryCount: number;
  likedCount: number;
  readCount: number;

  profileSourceCount: number;
  topSubjectsCount: number;
  topAuthorsCount: number;

  openLibraryCalls: { type: "subject" | "author"; q: string; limit: number; got: number }[];
  docsTotal: number;

  ownedWorkLookupsTried: number;
  ownedWorkLookupsSucceeded: number;
  ownedWorkKeysCount: number;

  candidatesSeen: number;
  candidatesWithIsbn: number;
  candidatesAfterOwnedIsbnFilter: number;
  candidatesAfterOwnedWorkFilter: number;
  candidatesAfterOwnedTitleAuthorFilter: number;

  editionLookupsTried: number;
  editionLookupsSucceeded: number;
  isbnResolvedViaEditionKey: number;

  candidateWorkLookupsTried: number;
  candidateWorkLookupsSucceeded: number;

  uniqueByKey: number;
  dedupDroppedByTitleAuthor: number;
  diversifiedDroppedByAuthor: number;
};

type Data =
  | {
      ok: true;
      profile: {
        likedCount: number;
        topSubjects: { subject: string; weight: number }[];
        topAuthors: { author: string; weight: number }[];
      };
      recommendations: RecItem[];
      debug?: DebugStats;
    }
  | { ok: false; error: string };

function safeParseSubjects(raw: string | null): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
  } catch {
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [s];
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function coverUrlFromIsbn(isbn: string) {
  return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg`;
}

function normalizeAuthorString(authors: string) {
  return authors
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (/^\d{13}$/.test(cleaned)) return cleaned;
  if (/^\d{9}[\dX]$/.test(cleaned)) return cleaned;
  return null;
}

function pickIsbn(isbns: unknown): string | null {
  if (!isbns) return null;
  const list: string[] = Array.isArray(isbns) ? (isbns as unknown[]).map(String) : [String(isbns)];

  const isbn13 = list.map(normalizeIsbn).find((x) => x != null && /^\d{13}$/.test(x));
  if (isbn13) return isbn13;

  const isbn10 = list.map(normalizeIsbn).find((x) => x != null && /^\d{9}[\dX]$/.test(x));
  if (isbn10) return isbn10;

  return null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normText(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleAuthorKey(title: string, authors: string) {
  const t = normText(title).slice(0, 140);
  const primaryAuthor = normText((authors || "").split(",")[0] || "").slice(0, 80);
  return `${t}__${primaryAuthor || "unknown"}`;
}

async function getUserFromRequest(req: NextApiRequest) {
  const sessionId = req.cookies?.bv_session || req.cookies?.session || null;
  if (!sessionId) return null;

  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { id: String(sessionId) },
    select: {
      expiresAt: true,
      user: { select: { id: true, email: true } },
    },
  });

  if (!session?.user) return null;
  if (session.expiresAt && session.expiresAt <= now) return null;
  return session.user;
}

type OpenLibraryDoc = {
  key?: string;
  work_key?: string[];
  title?: string;
  author_name?: string[];
  isbn?: string[];
  subject?: string[];
  subject_facet?: string[];
  edition_key?: string[];
};

type OpenLibraryEdition = {
  isbn_13?: string[];
  isbn_10?: string[];
};

type OpenLibraryIsbnEdition = {
  works?: { key?: string }[];
};

function normalizeWorkKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("/works/")) return s;
  if (/^OL\d+W$/.test(s)) return `/works/${s}`;
  return s;
}

function getWorkKeyFromSearchDoc(d: OpenLibraryDoc): string | null {
  const wk =
    (Array.isArray(d.work_key) && d.work_key.length > 0 ? normalizeWorkKey(d.work_key[0]) : null) ||
    normalizeWorkKey(d.key);
  return wk;
}

async function openLibrarySearch(q: string, limit: number) {
  const fields = ["key", "work_key", "title", "author_name", "isbn", "subject", "subject_facet", "edition_key"].join(",");
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=${encodeURIComponent(
    fields
  )}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OpenLibrary error ${r.status}`);
  const j = await r.json();
  const docs: OpenLibraryDoc[] = Array.isArray(j?.docs) ? j.docs : [];
  return docs;
}

async function fetchIsbnFromEditionKey(editionKey: string): Promise<string | null> {
  const url = `https://openlibrary.org/books/${encodeURIComponent(editionKey)}.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as OpenLibraryEdition;

  const isbn13 = Array.isArray(j?.isbn_13) ? j.isbn_13.map(normalizeIsbn).find((x) => x && /^\d{13}$/.test(x)) : null;
  if (isbn13) return isbn13;

  const isbn10 = Array.isArray(j?.isbn_10)
    ? j.isbn_10.map(normalizeIsbn).find((x) => x && /^\d{9}[\dX]$/.test(x))
    : null;
  if (isbn10) return isbn10;

  return null;
}

async function fetchWorkKeyFromIsbn(isbn: string): Promise<string | null> {
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;
  const url = `https://openlibrary.org/isbn/${encodeURIComponent(norm)}.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as OpenLibraryIsbnEdition;
  const wk = j?.works?.[0]?.key ? normalizeWorkKey(j.works[0].key) : null;
  return wk;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    const minRating = clamp(Number(req.query.minRating ?? 4), 1, 10);
    const seedMode = String(req.query.seedMode ?? "liked"); // liked | allRead
    const limit = Math.min(50, Math.max(10, Number(req.query.limit ?? 25)));
    const debugOn = String(req.query.debug ?? "") === "1";

    const entrySelect = {
      isbn: true,
      title: true,
      authors: true,
      status: true,
      rating: true,
      subjects: true,
    } satisfies Prisma.LibraryEntrySelect;

    const entries = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      select: entrySelect,
    });

    const debug: DebugStats = {
      seedMode,
      minRating,
      limit,

      entryCount: entries.length,
      likedCount: 0,
      readCount: 0,

      profileSourceCount: 0,
      topSubjectsCount: 0,
      topAuthorsCount: 0,

      openLibraryCalls: [],
      docsTotal: 0,

      ownedWorkLookupsTried: 0,
      ownedWorkLookupsSucceeded: 0,
      ownedWorkKeysCount: 0,

      candidatesSeen: 0,
      candidatesWithIsbn: 0,
      candidatesAfterOwnedIsbnFilter: 0,
      candidatesAfterOwnedWorkFilter: 0,
      candidatesAfterOwnedTitleAuthorFilter: 0,

      editionLookupsTried: 0,
      editionLookupsSucceeded: 0,
      isbnResolvedViaEditionKey: 0,

      candidateWorkLookupsTried: 0,
      candidateWorkLookupsSucceeded: 0,

      uniqueByKey: 0,
      dedupDroppedByTitleAuthor: 0,
      diversifiedDroppedByAuthor: 0,
    };

    // Owned ISBN set + owned title-author set
    const ownedIsbn = new Set<string>();
    const ownedTitleAuthor = new Set<string>();

    for (const e of entries) {
      const rawIsbn = String(e.isbn ?? "").trim();
      if (rawIsbn) ownedIsbn.add(rawIsbn);
      const n = normalizeIsbn(rawIsbn);
      if (n) ownedIsbn.add(n);

      const t = String(e.title ?? "").trim();
      const a = normalizeAuthorString(String(e.authors ?? "").trim());
      if (t) ownedTitleAuthor.add(titleAuthorKey(t, a));
    }

    const liked = entries.filter(
      (e) => e.status === "read" && typeof e.rating === "number" && (e.rating ?? 0) >= minRating
    );
    const readAll = entries.filter((e) => e.status === "read");

    debug.likedCount = liked.length;
    debug.readCount = readAll.length;

    const profileSource = seedMode === "allRead" ? readAll : liked;
    debug.profileSourceCount = profileSource.length;

    const ratingToWeight = (r: number) => clamp(r, 1, 10) / 2; // 1..10 -> 0.5..5

    const subjectWeight = new Map<string, number>();
    const authorWeight = new Map<string, number>();

    for (const e of profileSource) {
      const r = typeof e.rating === "number" ? Number(e.rating) : minRating;
      const w = ratingToWeight(r);

      const subs = safeParseSubjects(e.subjects);
      for (const s of subs) {
        const key = String(s).trim();
        if (!key) continue;
        subjectWeight.set(key, (subjectWeight.get(key) ?? 0) + w);
      }

      const a = String(e.authors ?? "").trim();
      if (a) {
        const key = normalizeAuthorString(a);
        authorWeight.set(key, (authorWeight.get(key) ?? 0) + w);
      }
    }

    const topSubjects = Array.from(subjectWeight.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([subject, weight]) => ({ subject, weight }));

    const topAuthors = Array.from(authorWeight.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([author, weight]) => ({ author, weight }));

    debug.topSubjectsCount = topSubjects.length;
    debug.topAuthorsCount = topAuthors.length;

    if (profileSource.length === 0) {
      return res.status(200).json({
        ok: true,
        profile: { likedCount: liked.length, topSubjects, topAuthors },
        recommendations: [],
        ...(debugOn ? { debug } : {}),
      });
    }

    // Resolve owned work keys (optional, best-effort)
    const ownedWorkKeys = new Set<string>();
    const ownedIsbnsToLookup = Array.from(ownedIsbn)
      .map((x) => normalizeIsbn(x))
      .filter((x): x is string => !!x);

    const MAX_OWNED_WORK_LOOKUPS = 80;
    const workCache = new Map<string, string | null>();

    for (const isbn of ownedIsbnsToLookup.slice(0, MAX_OWNED_WORK_LOOKUPS)) {
      if (workCache.has(isbn)) continue;
      debug.ownedWorkLookupsTried++;
      const wk = await fetchWorkKeyFromIsbn(isbn);
      workCache.set(isbn, wk);
      if (wk) {
        debug.ownedWorkLookupsSucceeded++;
        ownedWorkKeys.add(wk);
      }
    }
    debug.ownedWorkKeysCount = ownedWorkKeys.size;

    // Pull candidates
    const docs: OpenLibraryDoc[] = [];
    for (const ts of topSubjects) {
      const q = `subject:"${ts.subject}"`;
      const part = await openLibrarySearch(q, 25);
      docs.push(...part);
      debug.openLibraryCalls.push({ type: "subject", q, limit: 25, got: part.length });
    }
    for (const ta of topAuthors) {
      const q = `author:"${ta.author}"`;
      const part = await openLibrarySearch(q, 15);
      docs.push(...part);
      debug.openLibraryCalls.push({ type: "author", q, limit: 15, got: part.length });
    }
    debug.docsTotal = docs.length;

    const bestByKey = new Map<string, RecItem>();
    const bestByTitleAuthor = new Map<string, RecItem>();

    const MAX_EDITION_LOOKUPS = 40;
    const MAX_CANDIDATE_WORK_LOOKUPS = 90;
    const candidateWorkCache = new Map<string, string | null>();

    for (const d of docs) {
      debug.candidatesSeen++;

      let isbn = pickIsbn(d.isbn);

      if (
        !isbn &&
        Array.isArray(d.edition_key) &&
        d.edition_key.length > 0 &&
        debug.editionLookupsTried < MAX_EDITION_LOOKUPS
      ) {
        debug.editionLookupsTried++;
        const key = String(d.edition_key[0]);
        const resolved = await fetchIsbnFromEditionKey(key);
        if (resolved) {
          debug.editionLookupsSucceeded++;
          debug.isbnResolvedViaEditionKey++;
          isbn = resolved;
        }
      }

      if (!isbn) continue;
      debug.candidatesWithIsbn++;

      const normIsbn = normalizeIsbn(isbn) ?? isbn;

      // Owned ISBN filter
      if (ownedIsbn.has(isbn) || ownedIsbn.has(normIsbn)) continue;
      debug.candidatesAfterOwnedIsbnFilter++;

      const title = String(d.title ?? "").trim();
      if (!title) continue;

      const authorsArr = Array.isArray(d.author_name) ? d.author_name : [];
      const authors = authorsArr.map(String).filter(Boolean).join(", ") || "Unbekannt";
      const authorsNorm = normalizeAuthorString(authors);

      // Owned Title+Author filter (kills duplicates across editions/languages)
      const taKey = titleAuthorKey(title, authorsNorm);
      if (ownedTitleAuthor.has(taKey)) continue;
      debug.candidatesAfterOwnedTitleAuthorFilter++;

      // Work key best-effort
      let wk = getWorkKeyFromSearchDoc(d);

      if (normIsbn && debug.candidateWorkLookupsTried < MAX_CANDIDATE_WORK_LOOKUPS) {
        if (!candidateWorkCache.has(normIsbn)) {
          debug.candidateWorkLookupsTried++;
          const resolvedWk = await fetchWorkKeyFromIsbn(normIsbn);
          candidateWorkCache.set(normIsbn, resolvedWk);
          if (resolvedWk) debug.candidateWorkLookupsSucceeded++;
        }
        const resolved = candidateWorkCache.get(normIsbn) ?? null;
        if (resolved) wk = resolved;
      }

      if (wk && ownedWorkKeys.has(wk)) continue;
      debug.candidatesAfterOwnedWorkFilter++;

      const subjects = uniq(
        (Array.isArray(d.subject) ? d.subject : [])
          .concat(Array.isArray(d.subject_facet) ? d.subject_facet : [])
          .map(String)
          .map((x) => x.trim())
          .filter(Boolean)
      ).slice(0, 25);

      let score = 0;
      const overlap: { s: string; w: number }[] = [];

      for (const s of subjects) {
        const w = subjectWeight.get(s);
        if (w) {
          score += w;
          overlap.push({ s, w });
        }
      }

      const authorMatch = topAuthors.some((a) => authorsNorm.includes(a.author) || a.author.includes(authorsNorm));
      if (authorMatch) score += 6;

      score = score / Math.sqrt(1 + subjects.length / 8);

      const topOverlap = overlap.sort((a, b) => b.w - a.w).slice(0, 2);

      const reasons: Reason[] = [];
      if (topOverlap[0]) {
        reasons.push({
          label: "Themen-Überschneidung",
          detail: `passt zu „${topOverlap[0].s}“ (kommt oft in deinen Top-Büchern vor)`,
        });
      }
      if (topOverlap[1]) {
        reasons.push({
          label: "Mehr davon",
          detail: `auch verbunden mit „${topOverlap[1].s}“`,
        });
      }
      if (authorMatch) {
        reasons.push({ label: "Autor-Ähnlichkeit", detail: "Autor:in taucht in deinem Profil stark auf" });
      }
      if (reasons.length === 0) {
        reasons.push({ label: "Exploration", detail: "passt breit zu deinen gelesenen Büchern" });
      }

      // Primary key: work-key if present, else ISBN
      const primaryKey = wk ? `wk:${wk}` : `isbn:${normIsbn}`;

      const candidate: RecItem = {
        isbn: normIsbn,
        title,
        authors,
        coverUrl: coverUrlFromIsbn(normIsbn),
        score,
        reasons: reasons.slice(0, 3),
        subjects,
      };

      // 1) Keep best per work/isbn
      const existingPrimary = bestByKey.get(primaryKey);
      if (!existingPrimary || candidate.score > existingPrimary.score) {
        bestByKey.set(primaryKey, candidate);
      }

      // 2) Also keep best per title+author (super robust dedup)
      const existingTA = bestByTitleAuthor.get(taKey);
      if (!existingTA) {
        bestByTitleAuthor.set(taKey, candidate);
      } else {
        // If we already have one with same title+author, keep higher score and count drop
        if (candidate.score > existingTA.score) bestByTitleAuthor.set(taKey, candidate);
        debug.dedupDroppedByTitleAuthor++;
      }
    }

    // Now merge: use title+author map as final dedup base (strongest)
    const deduped = Array.from(bestByTitleAuthor.values()).sort((a, b) => b.score - a.score);
    debug.uniqueByKey = deduped.length;

    // Diversification: avoid one author dominating
    const MAX_PER_AUTHOR = 2;
    const perAuthorCount = new Map<string, number>();
    const diversified: RecItem[] = [];

    for (const it of deduped) {
      if (diversified.length >= limit) break;
      const primaryAuthor = normText((it.authors || "").split(",")[0] || "unbekannt").slice(0, 80);
      const cur = perAuthorCount.get(primaryAuthor) ?? 0;

      if (cur >= MAX_PER_AUTHOR) {
        debug.diversifiedDroppedByAuthor++;
        continue;
      }

      perAuthorCount.set(primaryAuthor, cur + 1);
      diversified.push(it);
    }

    return res.status(200).json({
      ok: true,
      profile: { likedCount: liked.length, topSubjects, topAuthors },
      recommendations: diversified,
      ...(debugOn ? { debug } : {}),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
