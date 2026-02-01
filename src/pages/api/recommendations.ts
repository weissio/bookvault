import type { NextApiRequest, NextApiResponse } from "next";
import prisma from "@/server/db";

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
    .replace(/[\u0300-\u036f]/g, "") // diacritics
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickPrimaryAuthor(authors: string) {
  // "A, B, C" -> "A"
  const a = (authors || "").split(",")[0]?.trim() || "";
  return a;
}

function authorLastName(author: string) {
  const parts = (author || "").trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : "";
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

async function openLibraryIsbnToWorkKey(isbn: string): Promise<string | null> {
  // https://openlibrary.org/isbn/{isbn}.json -> works[0].key
  try {
    const j = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`, 12000);
    const works = (j?.works || []) as Array<{ key?: string }>;
    const wk = works?.[0]?.key;
    return typeof wk === "string" ? wk : null;
  } catch {
    return null;
  }
}

async function openLibraryWorkToCanonicalKey(workKey: string): Promise<string | null> {
  // Use the work key itself as canonical key (if present)
  // Some installations used additional canonicalization, but here: stable = workKey
  return workKey || null;
}

/** -----------------------------
 *  Wikidata fallback for "same work"
 *  - Robust against titles with/without leading articles (The/Die/Der/Das...)
 *  - Tries multiple title variants and both DE/EN.
 *  - Returns a Q-ID string like "Q1212133" or null.
 *  ----------------------------- */
const wdCache = new Map<string, string | null>();

function stripLeadingArticle(t: string) {
  const s = (t || "").trim();
  return s
    .replace(/^(the|a|an|der|die|das|ein|eine|el|la|los|las|le|les)\s+/i, "")
    .trim();
}

function titleVariants(title: string, lang: "de" | "en") {
  const base = (title || "").trim();
  const noArt = stripLeadingArticle(base);

  const vars = new Set<string>();
  if (base) vars.add(base);
  if (noArt) vars.add(noArt);

  // Many EN Wikidata labels include "The ..."
  if (lang === "en") {
    const withThe = base.toLowerCase().startsWith("the ") ? base : `The ${base}`;
    const withTheNoArt = noArt.toLowerCase().startsWith("the ") ? noArt : `The ${noArt}`;
    if (withThe.trim()) vars.add(withThe.trim());
    if (withTheNoArt.trim()) vars.add(withTheNoArt.trim());
  }

  return Array.from(vars).filter(Boolean);
}

async function wikidataSearchWorkQid(title: string, lang: "de" | "en", authorHint?: string) {
  const cacheKey = `${lang}|${title}|${authorHint || ""}`;
  if (wdCache.has(cacheKey)) return wdCache.get(cacheKey)!;

  const a = norm(authorHint || "");
  const last = norm(authorLastName(authorHint || ""));

  const variants = titleVariants(title, lang);

  try {
    for (const v of variants) {
      const params = new URLSearchParams();
      params.set("action", "wbsearchentities");
      params.set("format", "json");
      params.set("limit", "8");
      params.set("language", lang);
      params.set("search", v);

      const url = `https://www.wikidata.org/w/api.php?${params.toString()}`;

      const j = await fetchJson(url, 15000, { Accept: "application/json" });
      const results = (j?.search || []) as Array<{
        id?: string;
        label?: string;
        description?: string;
      }>;

      const candidates = results.filter((r) => r?.id && typeof r.id === "string");
      if (!candidates.length) continue;

      const scored = candidates
        .map((r) => {
          const blob = norm(`${r.label || ""} ${r.description || ""}`);
          let s = 0;
          if (a && blob.includes(a)) s += 3;
          if (last && blob.includes(last)) s += 2;
          if (blob.includes("novel") || blob.includes("roman") || blob.includes("book")) s += 1;
          return { id: r.id as string, score: s };
        })
        .sort((x, y) => y.score - x.score);

      const best = scored[0]?.id ?? null;
      wdCache.set(cacheKey, best);
      return best;
    }

    wdCache.set(cacheKey, null);
    return null;
  } catch {
    wdCache.set(cacheKey, null);
    return null;
  }
}

async function wikidataWorkKeyForBook(title: string, authors: string) {
  const a = pickPrimaryAuthor(authors);

  // Try DE then EN; each uses robust title variants
  const de = await wikidataSearchWorkQid(title, "de", a);
  if (de) return `wd:${de}`;

  const en = await wikidataSearchWorkQid(title, "en", a);
  if (en) return `wd:${en}`;

  return null;
}

/** -----------------------------
 *  Profil ableiten aus Bibliothek
 *  ----------------------------- */
function computeProfile(entries: any[], minRating: number): Profile {
  const liked = entries.filter(
    (e) => e.status === "read" && typeof e.rating === "number" && (e.rating ?? 0) >= minRating
  );

  // subjects weighting
  const subjWeights = new Map<string, number>();
  const authWeights = new Map<string, number>();

  for (const e of liked) {
    const rating = typeof e.rating === "number" ? e.rating : minRating;
    const w = clamp(rating, minRating, 10); // 4..10

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

  return {
    likedCount: liked.length,
    topSubjects,
    topAuthors,
  };
}

/** -----------------------------
 *  Candidate gathering (OpenLibrary)
 *  ----------------------------- */
async function openLibraryCandidatesBySubject(subject: string, limit: number) {
  // subject API: https://openlibrary.org/subjects/{subject}.json?limit=...
  // But subjects often contain commas/spaces; OpenLibrary expects slug-ish.
  // We keep it simple: use search.json by subject term
  const params = new URLSearchParams();
  params.set("q", subject);
  params.set("mode", "everything");
  params.set("limit", String(limit));
  params.set("fields", "title,author_name,isbn,subject,cover_i,edition_key,key");

  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  const j = await fetchJson(url, 15000);
  const docs = (j?.docs || []) as any[];
  return docs;
}

function bestIsbnFromDoc(doc: any): string | null {
  const isbns: string[] = Array.isArray(doc?.isbn) ? doc.isbn : [];
  // Prefer ISBN-13
  const isbn13 = isbns.find((x) => typeof x === "string" && x.replace(/[^0-9]/g, "").length === 13);
  const isbn10 = isbns.find((x) => typeof x === "string" && x.replace(/[^0-9Xx]/g, "").length === 10);
  const pick = isbn13 || isbn10;
  return pick ? pick.replace(/[^0-9Xx]/g, "") : null;
}

function authorsFromDoc(doc: any): string {
  const arr: string[] = Array.isArray(doc?.author_name) ? doc.author_name : [];
  return arr.slice(0, 3).join(", ");
}

function subjectsFromDoc(doc: any): string[] {
  const arr: string[] = Array.isArray(doc?.subject) ? doc.subject : [];
  return arr.slice(0, 12);
}

/** -----------------------------
 *  Scoring
 *  ----------------------------- */
function scoreCandidate(doc: any, profile: Profile) {
  const docSubjects: string[] = subjectsFromDoc(doc);
  const docAuthors = (Array.isArray(doc?.author_name) ? doc.author_name : []) as string[];

  const topSubj = profile.topSubjects.map((s) => s.subject);
  const topAuth = profile.topAuthors.map((a) => a.author);

  // subject overlap score
  const set = new Set(docSubjects.map((s) => norm(s)));
  let subjHits: string[] = [];
  let score = 0;

  for (const s of topSubj) {
    if (set.has(norm(s))) {
      score += 5; // strong signal
      subjHits.push(s);
    }
  }

  // author similarity
  const docAuthNorm = new Set(docAuthors.map((a) => norm(a)));
  const authHit = topAuth.find((a) => docAuthNorm.has(norm(a)));
  if (authHit) score += 7;

  // mild boost if has many subjects
  score += Math.min(3, docSubjects.length / 6);

  // Reasons (transparent)
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
      detail: `Autor:in taucht in deinem Profil stark auf`,
    });
  }

  return { score, reasons };
}

/** -----------------------------
 *  Dedup / Canonical keys
 *  ----------------------------- */
async function buildOwnedKeys(entries: any[], debug: DebugInfo) {
  // 1) ISBN set
  const ownedIsbn = new Set<string>();
  for (const e of entries) {
    if (e?.isbn) ownedIsbn.add(String(e.isbn));
  }

  // 2) OpenLibrary work canonical keys
  const ownedOLWork = new Set<string>();
  let tried = 0;
  let succeeded = 0;

  for (const e of entries) {
    const isbn = String(e?.isbn || "");
    if (!isbn) continue;
    tried++;
    const wk = await openLibraryIsbnToWorkKey(isbn);
    if (wk) {
      succeeded++;
      const canon = await openLibraryWorkToCanonicalKey(wk);
      if (canon) ownedOLWork.add(`ol:${canon}`);
    }
  }

  debug.ownedWorkLookupsTried = tried;
  debug.ownedWorkLookupsSucceeded = succeeded;

  // 3) Wikidata fallback keys (title+author)
  const ownedWDWork = new Set<string>();
  let wdTried = 0;
  let wdHit = 0;

  for (const e of entries) {
    const title = String(e?.title || "").trim();
    const authors = String(e?.authors || "").trim();
    if (!title) continue;
    wdTried++;
    const wdKey = await wikidataWorkKeyForBook(title, authors);
    if (wdKey) {
      wdHit++;
      ownedWDWork.add(wdKey);
    }
  }

  debug.ownedWikidataTried = wdTried;
  debug.ownedWikidataHit = wdHit;

  return { ownedIsbn, ownedOLWork, ownedWDWork };
}

async function canonicalKeyForCandidate(rec: Recommendation, debug: DebugInfo) {
  // Prefer OpenLibrary work canonical
  const wk = await openLibraryIsbnToWorkKey(rec.isbn);
  if (wk) {
    const canon = await openLibraryWorkToCanonicalKey(wk);
    if (canon) return `ol:${canon}`;
  }

  // Fallback to Wikidata title+author
  const wd = await wikidataWorkKeyForBook(rec.title, rec.authors);
  if (wd) return wd;

  // last resort: normalized title+author
  const a = authorLastName(pickPrimaryAuthor(rec.authors));
  return `na:${norm(rec.title)}|${norm(a)}`;
}

/** -----------------------------
 *  Handler
 *  ----------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const user = await getSessionUser(req);
    if (!user) return jsonErr(res, 401, "Not authenticated");

    const limit = clamp(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1, 50);
    const minRating = clamp(parseInt(String(req.query.minRating ?? "4"), 10) || 4, 0, 10);
    const seedMode = String(req.query.seedMode ?? "liked"); // currently only liked
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

    const profile = computeProfile(entries, minRating);
    debug.profile = profile;

    // If no liked books, return empty rec list (transparent)
    if (profile.likedCount === 0) {
      return jsonOk(res, {
        user,
        profile,
        recommendations: [],
        debug: debugMode ? debug : undefined,
      });
    }

    // Build owned keys
    const { ownedIsbn, ownedOLWork, ownedWDWork } = await buildOwnedKeys(entries, debug);
    debug.ownedWorkKeysCount = ownedOLWork.size;
    debug.ownedWikidataKeysCount = ownedWDWork.size;

    // Gather candidates from OpenLibrary based on top subjects
    const topSubjects = profile.topSubjects.map((x) => x.subject);
    const docs: any[] = [];

    // Keep requests bounded
    const perSubject = clamp(Math.ceil(120 / Math.max(1, topSubjects.length)), 10, 40);

    for (const s of topSubjects) {
      const c = await openLibraryCandidatesBySubject(s, perSubject);
      docs.push(...c);
    }

    // Score + transform
    const scored: Array<{ rec: Recommendation; raw: any }> = [];
    for (const doc of docs) {
      const isbn = bestIsbnFromDoc(doc);
      if (!isbn) continue;

      const title = String(doc?.title || "").trim();
      if (!title) continue;

      const authors = authorsFromDoc(doc);
      const subjects = subjectsFromDoc(doc);

      const { score, reasons } = scoreCandidate(doc, profile);
      if (score <= 0) continue;

      scored.push({
        raw: doc,
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

    // Sort by score descending
    scored.sort((a, b) => b.rec.score - a.rec.score);

    // Dedup + filter out owned items:
    const out: Recommendation[] = [];
    const seenCanon = new Set<string>();
    const seenIsbn = new Set<string>();

    let canonTried = 0;
    let canonOlHit = 0;
    let canonWdHit = 0;

    for (const s of scored) {
      if (out.length >= limit) break;

      const r = s.rec;
      if (ownedIsbn.has(r.isbn)) continue;
      if (seenIsbn.has(r.isbn)) continue;

      canonTried++;
      const ck = await canonicalKeyForCandidate(r, debug);

      if (ck.startsWith("ol:")) canonOlHit++;
      if (ck.startsWith("wd:")) canonWdHit++;

      // If candidate work exists in owned works (OL) or owned WD works, skip
      if (ownedOLWork.has(ck) || ownedWDWork.has(ck)) continue;

      // Also skip duplicates among recommendations
      if (seenCanon.has(ck)) continue;

      seenIsbn.add(r.isbn);
      seenCanon.add(ck);
      out.push(r);
    }

    debug.candidateCanonTried = canonTried;
    debug.candidateCanonOlHit = canonOlHit;
    debug.candidateCanonWdHit = canonWdHit;
    debug.uniqueByCanonicalOrWorkOrIsbn = seenCanon.size;

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
