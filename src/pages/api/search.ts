import type { NextApiRequest, NextApiResponse } from "next";

type Result = {
  isbn: string;
  title: string;
  authors: string;
  coverUrl?: string;
};

const UA = { "User-Agent": "bookvault-dev/0.1 (local development)" };

function looksLikeIsbn(input: string) {
  return /^[0-9Xx-]{10,17}$/.test(input);
}

function normalizeIsbn(input: string) {
  return input.replace(/[^0-9Xx]/g, "").toUpperCase();
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
 * versuchen wir zusätzlich eine autor-fokussierte Suche.
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
        },
      ],
    });
  }

  // ─────────────────────────────────────────────
  // 2) Text → breiter suchen, mehr Treffer prüfen
  // ─────────────────────────────────────────────
  const urls: string[] = [];

  // Allgemeine Suche (Titel/Autor/Stichworte)
  urls.push(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=100`);

  // Zusatz: wenn es wie ein Name wirkt, extra autor= Suche
  if (looksLikePersonName(q)) {
    urls.push(`https://openlibrary.org/search.json?author=${encodeURIComponent(q)}&limit=100`);
  }

  // Docs sammeln (merge)
  const docsMerged: any[] = [];
  for (const url of urls) {
    const docs = await runSearchDocs(url);
    docsMerged.push(...docs);
  }

  const results: Result[] = [];
  const seenIsbn = new Set<string>();

  // Wir versuchen bis zu 20 Ergebnisse zu liefern (statt 5),
  // damit einzelne Titel seltener “fehlen”.
  const TARGET = 20;

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

    // Deduplizieren
    if (seenIsbn.has(isbn)) continue;
    seenIsbn.add(isbn);

    results.push({
      isbn,
      title,
      authors,
      coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`,
    });
  }

  return res.status(200).json({ ok: true, results });
}
