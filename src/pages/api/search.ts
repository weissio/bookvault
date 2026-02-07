import type { NextApiRequest, NextApiResponse } from "next";

type Result = {
  isbn?: string;
  title: string;
  authors: string;
  coverUrl?: string;
  description?: string;
  canSave?: boolean;
};

const UA = { "User-Agent": "bookvault-dev/0.1 (local development)" };
const GOOGLE_BOOKS_API_KEY = String(process.env.GOOGLE_BOOKS_API_KEY || "").trim();

function looksLikeIsbn(input: string) {
  return /^[0-9Xx-]{10,17}$/.test(input);
}

function normalizeIsbn(input: string) {
  return input.replace(/[^0-9Xx]/g, "").toUpperCase();
}

function isbn13To10(isbn13: string): string | null {
  const n = isbn13.replace(/[^0-9]/g, "");
  if (n.length !== 13) return null;
  if (!n.startsWith("978") && !n.startsWith("979")) return null;
  const core = n.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (i + 1) * Number(core[i]);
  }
  const mod = sum % 11;
  const check = mod === 10 ? "X" : String(mod);
  return core + check;
}

async function fetchJson(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchGoogleBooks(query: string, limit: number, langRestrict?: string): Promise<Result[]> {
  if (!GOOGLE_BOOKS_API_KEY) return [];

  const params = new URLSearchParams();
  params.set("q", query);
  params.set("printType", "books");
  params.set("maxResults", String(Math.min(40, Math.max(1, limit))));
  if (langRestrict) params.set("langRestrict", langRestrict);
  params.set("key", GOOGLE_BOOKS_API_KEY);

  const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
  const j = await fetchJson(url);
  const items = Array.isArray(j?.items) ? j.items : [];

  const out: Result[] = [];
  for (const it of items) {
    const vi = it?.volumeInfo || {};
    const title = String(vi?.title || "").trim();
    if (!title) continue;

    const authors = Array.isArray(vi?.authors) ? vi.authors.map((x: any) => String(x).trim()).filter(Boolean) : [];
    const identifiers = Array.isArray(vi?.industryIdentifiers) ? vi.industryIdentifiers : [];
    let isbn = "";
    for (const id of identifiers) {
      const type = String(id?.type || "").toUpperCase();
      const val = String(id?.identifier || "").trim();
      if (!val) continue;
      if (type === "ISBN_13") {
        isbn = val;
        break;
      }
      if (!isbn && type === "ISBN_10") isbn = val;
    }

    const cover = vi?.imageLinks?.thumbnail || vi?.imageLinks?.smallThumbnail || undefined;
    const desc = typeof vi?.description === "string" ? vi.description.trim() : undefined;

    out.push({
      isbn: isbn || undefined,
      title,
      authors: authors.length ? authors.join(", ") : "Unbekannt",
      coverUrl: cover,
      description: desc,
      canSave: Boolean(isbn),
    });
  }

  return out;
}

function pickIsbnFromEditionJson(editionJson: any): string | null {
  const isbn13 =
    Array.isArray(editionJson?.isbn_13) && editionJson.isbn_13.length
      ? editionJson.isbn_13[0]
      : null;
  if (isbn13) return isbn13;

  const isbn10 =
    Array.isArray(editionJson?.isbn_10) && editionJson.isbn_10.length
      ? editionJson.isbn_10[0]
      : null;
  if (isbn10) return isbn10;

  return null;
}

async function fetchEditionIsbnByEditionKey(editionKey: string): Promise<string | null> {
  const j = await fetchJson(`https://openlibrary.org/books/${editionKey}.json`);
  if (!j) return null;
  return pickIsbnFromEditionJson(j);
}

async function fetchEditionIsbnByWorkKey(workKey: string): Promise<string | null> {
  const j = await fetchJson(`https://openlibrary.org${workKey}/editions.json?limit=25`);
  if (!j) return null;

  const entries: any[] = Array.isArray(j.entries) ? j.entries : [];
  for (const e of entries) {
    const isbn = pickIsbnFromEditionJson(e);
    if (isbn) return isbn;
  }
  return null;
}

/**
 * Heuristik: wenn Query wie ein Personenname aussieht,
 * versuchen wir zusaetzlich eine autor-fokussierte Suche.
 * (Keine Magie, nur ein Extra-Recall.)
 */
function looksLikePersonName(q: string) {
  const parts = q.trim().split(/\s+/);
  return parts.length >= 2 && q.length <= 40;
}

async function runSearchDocs(url: string): Promise<any[]> {
  const j = await fetchJson(url);
  if (!j) return [];
  const docs: any[] = Array.isArray(j.docs) ? j.docs : [];
  return docs;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = (req.query.q ?? "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Leere Suche" });

  // ─────────────────────────────────────────────
  // 1) ISBN → exakte Suche
  // ─────────────────────────────────────────────
  if (looksLikeIsbn(q)) {
    const isbn = normalizeIsbn(q);

    const gbPrimary = await fetchGoogleBooks(`isbn:${isbn}`, 3, "de");
    const gbHit = gbPrimary.find((x) => x.isbn);
    if (gbHit?.isbn) {
      return res.status(200).json({ ok: true, results: [gbHit] });
    }

    const isbn10 = isbn13To10(isbn);
    if (isbn10) {
      const gb10 = await fetchGoogleBooks(`isbn:${isbn10}`, 3, "de");
      const gb10Hit = gb10.find((x) => x.isbn);
      if (gb10Hit?.isbn) {
        return res.status(200).json({ ok: true, results: [gb10Hit] });
      }
    }

    const gbLoose = await fetchGoogleBooks(isbn, 3, "de");
    const gbLooseHit = gbLoose.find((x) => x.isbn);
    if (gbLooseHit?.isbn) {
      return res.status(200).json({ ok: true, results: [gbLooseHit] });
    }

    const j = await fetchJson(`https://openlibrary.org/isbn/${isbn}.json`);
    if (!j) return res.status(404).json({ ok: false, error: "Nicht gefunden" });

    // Autoren nachladen (optional)
    let authors = "Unbekannt";
    if (Array.isArray(j.authors) && j.authors.length) {
      const names: string[] = [];
      for (const a of j.authors.slice(0, 3)) {
        if (a?.key) {
          const aj = await fetchJson(`https://openlibrary.org${a.key}.json`);
          if (aj?.name) names.push(aj.name);
        }
      }
      if (names.length) authors = names.join(", ");
    }

    return res.status(200).json({
      ok: true,
      results: [
        {
          isbn,
          title: j.title ?? "Ohne Titel",
          authors,
          coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`,
          canSave: true,
        },
      ],
    });
  }

  // ─────────────────────────────────────────────
  // 2) Text → Google Books zuerst, OpenLibrary als Fallback
  // ─────────────────────────────────────────────
  const TARGET = 20;
  const results: Result[] = [];
  const seenIsbn = new Set<string>();
  const seenTitleAuthor = new Set<string>();

  function addResult(r: Result) {
    const isbn = r.isbn ? normalizeIsbn(r.isbn) : "";
    if (isbn) {
      if (seenIsbn.has(isbn)) return;
      seenIsbn.add(isbn);
      results.push({ ...r, isbn, canSave: true });
      return;
    }

    const key = `${r.title.toLowerCase()}|${r.authors.toLowerCase()}`;
    if (seenTitleAuthor.has(key)) return;
    seenTitleAuthor.add(key);
    results.push({ ...r, isbn: undefined, canSave: false });
  }

  const gbTitle = await fetchGoogleBooks(`intitle:"${q}"`, TARGET, "de");
  for (const r of gbTitle) {
    if (results.length >= TARGET) break;
    addResult(r);
  }

  const gbDe = await fetchGoogleBooks(q, TARGET, "de");
  for (const r of gbDe) {
    if (results.length >= TARGET) break;
    addResult(r);
  }

  const gbFallback = await fetchGoogleBooks(q, TARGET);
  for (const r of gbFallback) {
    if (results.length >= TARGET) break;
    addResult(r);
  }

  // OpenLibrary als Fallback/Ergaenzung
  const urls: string[] = [];
  urls.push(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=100`);
  if (looksLikePersonName(q)) {
    urls.push(`https://openlibrary.org/search.json?author=${encodeURIComponent(q)}&limit=100`);
  }

  const docsMerged: any[] = [];
  for (const url of urls) {
    const docs = await runSearchDocs(url);
    docsMerged.push(...docs);
  }

  for (const d of docsMerged) {
    if (results.length >= TARGET) break;

    const title: string = d.title ?? "Ohne Titel";
    const authors: string =
      Array.isArray(d.author_name) && d.author_name.length
        ? d.author_name.join(", ")
        : "Unbekannt";

    let isbn: string | null =
      Array.isArray(d.isbn) && d.isbn.length ? d.isbn[0] : null;

    if (!isbn && Array.isArray(d.edition_key) && d.edition_key.length) {
      isbn = await fetchEditionIsbnByEditionKey(d.edition_key[0]);
    }

    if (!isbn && typeof d.key === "string" && d.key.startsWith("/works/")) {
      isbn = await fetchEditionIsbnByWorkKey(d.key);
    }

    if (!isbn) continue;

    const normIsbn = normalizeIsbn(isbn);
    if (seenIsbn.has(normIsbn)) continue;
    seenIsbn.add(normIsbn);

    results.push({
      isbn: normIsbn,
      title,
      authors,
      coverUrl: `https://covers.openlibrary.org/b/isbn/${normIsbn}-M.jpg`,
      canSave: true,
    });
  }

  return res.status(200).json({ ok: true, results });
}
