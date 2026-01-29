import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = (req.query.q ?? "").toString().trim();
  if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

  const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=5`;

  const searchResp = await fetch(searchUrl, {
    headers: { "User-Agent": "bookvault-dev/0.1 (local development)" },
  });

  const searchStatus = {
    ok: searchResp.ok,
    status: searchResp.status,
    statusText: searchResp.statusText,
    url: searchUrl,
  };

  let searchJson: any = null;
  let searchText: string | null = null;

  try {
    searchJson = await searchResp.json();
  } catch {
    try {
      searchText = await searchResp.text();
    } catch {
      searchText = "<could not read body>";
    }
  }

  const docs: any[] = Array.isArray(searchJson?.docs) ? searchJson.docs : [];

  // Zeige stark reduziert die Struktur der ersten Docs
  const docSummaries = docs.slice(0, 5).map((d: any, idx: number) => ({
    idx,
    title: d.title,
    author_name: d.author_name,
    has_isbn: Array.isArray(d.isbn) ? d.isbn.length : 0,
    isbn0: Array.isArray(d.isbn) && d.isbn.length ? d.isbn[0] : null,
    has_edition_key: Array.isArray(d.edition_key) ? d.edition_key.length : 0,
    edition_key0:
      Array.isArray(d.edition_key) && d.edition_key.length ? d.edition_key[0] : null,
    key: d.key, // z.B. "/works/OL....W"
    seed: d.seed, // enthält oft Edition/Work Links
  }));

  // Wenn ein edition_key existiert, probieren wir EINE Edition nachzuladen
  let editionDebug: any = null;
  const firstWithEdition = docs.find((d: any) => Array.isArray(d.edition_key) && d.edition_key.length);

  if (firstWithEdition) {
    const ek = firstWithEdition.edition_key[0];
    const editionUrl = `https://openlibrary.org/books/${ek}.json`;

    const edResp = await fetch(editionUrl, {
      headers: { "User-Agent": "bookvault-dev/0.1 (local development)" },
    });

    let edJson: any = null;
    let edText: string | null = null;
    try {
      edJson = await edResp.json();
    } catch {
      try {
        edText = await edResp.text();
      } catch {
        edText = "<could not read body>";
      }
    }

    editionDebug = {
      edition_key: ek,
      url: editionUrl,
      resp: { ok: edResp.ok, status: edResp.status, statusText: edResp.statusText },
      isbn_13: edJson?.isbn_13 ?? null,
      isbn_10: edJson?.isbn_10 ?? null,
      raw_preview: edJson ? Object.keys(edJson).slice(0, 30) : edText,
    };
  } else {
    editionDebug = { note: "No doc with edition_key in first 5 results." };
  }

  return res.status(200).json({
    ok: true,
    searchStatus,
    numFound: searchJson?.numFound ?? null,
    docsCount: docs.length,
    docSummaries,
    editionDebug,
    rawSearchKeys: searchJson ? Object.keys(searchJson) : null,
    rawSearchTextIfNotJson: searchText,
  });
}
