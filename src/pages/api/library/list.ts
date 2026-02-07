import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import type { Prisma } from "@prisma/client";

type Data =
  | {
      ok: true;
      entries: Array<{
        id: number;
        isbn: string;
        title: string;
        authors: string;
        coverUrl: string | null;
        status: string;
        rating: number | null;
        notes: string | null;
        subjects: string | null;
        description: string | null;
        recommended: boolean;
        createdAt: string;
      }>;
    }
  | { ok: false; error: string };

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normIsbn(isbn: string) {
  return (isbn || "").replace(/[^0-9X]/gi, "").toUpperCase();
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

async function getUserFromRequest(req: NextApiRequest) {
  const sessionId = req.cookies?.bv_session || req.cookies?.session || null;
  if (!sessionId) return null;

  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { token: String(sessionId) },
    select: {
      expiresAt: true,
      user: { select: { id: true, email: true } },
    },
  });

  if (!session?.user) return null;
  if (session.expiresAt && session.expiresAt <= now) return null;
  return session.user;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    // Wichtig: Kein updatedAt, kein meta -> nur Felder die im Schema sicher existieren
    const select = {
      id: true,
      isbn: true,
      title: true,
      authors: true,
      coverUrl: true,
      status: true,
      rating: true,
      notes: true,
      subjects: true,
      description: true,
      createdAt: true,
    } satisfies Prisma.LibraryEntrySelect;

    const rows = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
      select,
    });

    const recEvents = await prisma.recommendationEvent.findMany({
      where: { userId: user.id, event: "saved_from_recommendation" },
      select: { workKey: true, valueJson: true },
    });

    const workKeySet = new Set<string>();
    const isbnSet = new Set<string>();

    for (const ev of recEvents) {
      if (ev.workKey) workKeySet.add(ev.workKey);
      const v = ev.valueJson as any;
      const evIsbn = normIsbn(String(v?.isbn || ""));
      if (evIsbn) isbnSet.add(evIsbn);
    }

    const entries = rows.map((r) => ({
      id: r.id,
      isbn: r.isbn,
      title: r.title,
      authors: r.authors,
      coverUrl: r.coverUrl,
      status: r.status,
      rating: r.rating,
      notes: r.notes,
      subjects: r.subjects,
      description: r.description,
      recommended:
        r.status !== "read" &&
        (() => {
          const entryIsbn = normIsbn(r.isbn);
          const entryIsbnKey = entryIsbn ? `isbn:${entryIsbn}` : "";
          const entryFallback = fallbackKey(r.title, r.authors, entryIsbn);
          return (
            (entryIsbn && isbnSet.has(entryIsbn)) ||
            (entryIsbnKey && workKeySet.has(entryIsbnKey)) ||
            workKeySet.has(entryFallback)
          );
        })(),
      createdAt: r.createdAt.toISOString(),
    }));

    return res.status(200).json({ ok: true, entries });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
