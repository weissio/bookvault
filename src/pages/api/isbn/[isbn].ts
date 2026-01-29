import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const raw = (req.query.isbn ?? "").toString();
  const isbn = raw.replace(/[^0-9Xx]/g, "").toUpperCase();

  if (isbn.length !== 10 && isbn.length !== 13) {
    return res.status(400).json({ ok: false, error: "Ungültige ISBN" });
  }

  const r = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!r.ok) {
    return res.status(404).json({ ok: false, error: "Nicht gefunden" });
  }

  const j: any = await r.json();

  let authors = "Unbekannt";
  if (Array.isArray(j.authors)) {
    const names: string[] = [];
    for (const a of j.authors.slice(0, 3)) {
      if (a?.key) {
        const ar = await fetch(`https://openlibrary.org${a.key}.json`);
        if (ar.ok) {
          const aj: any = await ar.json();
          if (aj?.name) names.push(aj.name);
        }
      }
    }
    if (names.length) authors = names.join(", ");
  }

  res.status(200).json({
    ok: true,
    book: {
      isbn,
      title: j.title ?? "Ohne Titel",
      authors,
      coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`,
    },
  });
}
