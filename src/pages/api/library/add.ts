import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; entry: any }
  | { ok: false; error: string };

function getCookie(req: NextApiRequest, name: string) {
  const raw = req.headers.cookie ?? "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function requireUserId(req: NextApiRequest) {
  const sessionId = getCookie(req, "bv_session");
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { token: sessionId },
    select: { userId: true, expiresAt: true },
  });

  if (!session) return null;

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await prisma.session.delete({ where: { token: sessionId } }).catch(() => {});
    return null;
  }

  return session.userId;
}


function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'"] /g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickPrimaryAuthor(authors: string) {
  return (authors || "").split(",")[0]?.trim() || "";
}

function titleTokenKey(title: string) {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "der", "die", "das", "ein", "eine", "und", "oder", "von", "zu", "mit", "im", "am",
    "le", "la", "les", "de", "des", "du", "et", "un", "une",
    "el", "los", "las", "del", "y", "un", "una",
  ]);

  return norm(title)
    .split(" ")
    .filter(Boolean)
    .filter((t) => !stop.has(t))
    .slice(0, 10)
    .join(" ");
}

function fallbackKey(title: string, authors: string, isbn: string) {
  const ak = norm(pickPrimaryAuthor(authors));
  const tk = titleTokenKey(title);
  if (ak && tk) return `na:${ak}|${tk}`;
  if (isbn) return `isbn:${isbn}`;
  return `manual:${Date.now()}`;
}

function normalizeDescription(desc: any): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc.trim() || null;
  if (typeof desc === "object" && typeof desc.value === "string") {
    const v = desc.value.trim();
    return v || null;
  }
  return null;
}

function uniqueTop(arr: string[], limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const v = String(s || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

async function safeJson(url: string) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

/**
 * Robust OpenLibrary meta:
 * ISBN -> /isbn/{isbn}.json (edition) -> works[0].key -> /works/{id}.json
 * subjects: work.subjects (fallback: edition.subjects if present)
 * description: work.description (fallback: edition.description)
 */
async function fetchOpenLibraryMetaByIsbn(isbn: string) {
  const clean = isbn.replace(/[^0-9Xx]/g, "");
  if (!clean) return { subjects: null as string[] | null, description: null as string | null };

  const editionUrl = `https://openlibrary.org/isbn/${encodeURIComponent(clean)}.json`;
  const edition = await safeJson(editionUrl);

  let workKey: string | null = null;
  if (edition?.works?.[0]?.key && typeof edition.works[0].key === "string") {
    workKey = edition.works[0].key; // "/works/OL....W"
  }

  let work: any = null;
  if (workKey) {
    work = await safeJson(`https://openlibrary.org${workKey}.json`);
  }

  const subjectsRawWork: string[] = Array.isArray(work?.subjects) ? work.subjects : [];
  const subjectsRawEdition: string[] = Array.isArray(edition?.subjects) ? edition.subjects : [];

  const subjects = uniqueTop(
    subjectsRawWork.length ? subjectsRawWork : subjectsRawEdition,
    20
  );

  const description =
    normalizeDescription(work?.description) ??
    normalizeDescription(edition?.description) ??
    null;

  return {
    subjects: subjects.length ? subjects : null,
    description,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Not logged in" });

    const {
      isbn,
      title,
      authors,
      coverUrl = null,
      status = "unread",
      rating = null,
      notes = null,
      source = null,
      recId = null,
      workKey = null,
    } = req.body ?? {};

    if (!isbn || !title || !authors) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: isbn, title, authors",
      });
    }

    const isbnStr = String(isbn).trim();
    const titleStr = String(title).trim();
    const authorsStr = String(authors).trim();

    // ✅ Meta fetch (best effort)
    let subjectsJson: string | null = null;
    let description: string | null = null;
    try {
      const meta = await fetchOpenLibraryMetaByIsbn(isbnStr);
      if (meta.subjects) subjectsJson = JSON.stringify(meta.subjects);
      if (meta.description) description = meta.description;
    } catch {
      // ignore
    }

    const existing = await prisma.libraryEntry.findFirst({
      where: { userId, isbn: isbnStr },
      select: { id: true, subjects: true, description: true },
    });

    // If meta is empty but entry already has meta, keep existing.
    const subjectsToWrite =
      subjectsJson ?? (existing?.subjects ?? null);
    const descToWrite =
      description ?? (existing?.description ?? null);

    const entry = existing
      ? await prisma.libraryEntry.update({
          where: { id: existing.id },
          data: {
            title: titleStr,
            authors: authorsStr,
            coverUrl: coverUrl ? String(coverUrl) : null,
            status: String(status),
            rating: rating === null || rating === undefined ? null : Number(rating),
            notes: notes === null || notes === undefined ? null : String(notes),

            subjects: subjectsToWrite,
            description: descToWrite,
          },
        })
      : await prisma.libraryEntry.create({
          data: {
            userId,
            isbn: isbnStr,
            title: titleStr,
            authors: authorsStr,
            coverUrl: coverUrl ? String(coverUrl) : null,
            status: String(status),
            rating: rating === null || rating === undefined ? null : Number(rating),
            notes: notes === null || notes === undefined ? null : String(notes),

            subjects: subjectsToWrite,
            description: descToWrite,
          },
        });

    if (String(source) === "recommendation") {
      try {
        const wk = workKey && String(workKey).trim() ? String(workKey).trim() : "";
        const key = wk ? (wk.startsWith("/") ? `ol:${wk}` : wk) : fallbackKey(titleStr, authorsStr, isbnStr);
        await prisma.recommendationEvent.create({
          data: {
            userId,
            workKey: key,
            event: "saved_from_recommendation",
            valueJson: { recId, isbn: isbnStr, title: titleStr, authors: authorsStr },
          },
        });
      } catch {
        // ignore
      }
    }

    return res.status(200).json({ ok: true, entry });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
