import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | {
      ok: true;
      entries: {
        id: number;
        isbn: string | null;
        title: string | null;
        authors: string | null;
        coverUrl: string | null;
        status: string | null;
        rating: number | null;
        notes: string | null;
        subjects: string | null;
        description: string | null;
        meta: string | null;
        createdAt: string;
        updatedAt: string;
      }[];
      refreshed?: { attempted: number; updated: number };
    }
  | { ok: false; error: string };

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

function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (/^\d{13}$/.test(cleaned)) return cleaned;
  if (/^\d{9}[\dX]$/.test(cleaned)) return cleaned;
  return null;
}

async function fetchOpenLibraryMetaByIsbn(isbn: string): Promise<{
  description: string | null;
  subjects: string[]; // as list; we store JSON string
  raw: any;
} | null> {
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;

  // OpenLibrary ISBN endpoint
  const url = `https://openlibrary.org/isbn/${encodeURIComponent(norm)}.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();

  // description may be string or { value: string }
  let description: string | null = null;
  const d = (j as any)?.description;
  if (typeof d === "string") description = d.trim() || null;
  else if (d && typeof d?.value === "string") description = String(d.value).trim() || null;

  // subjects in this endpoint are often missing; try follow work if present
  let subjects: string[] = [];

  const works = Array.isArray((j as any)?.works) ? (j as any).works : [];
  const workKey = works?.[0]?.key ? String(works[0].key) : null;

  if (workKey) {
    const wr = await fetch(`https://openlibrary.org${workKey}.json`);
    if (wr.ok) {
      const wj = await wr.json();
      const ss = (wj as any)?.subjects;
      if (Array.isArray(ss)) subjects = ss.map((x: any) => String(x)).filter(Boolean);
      if (!description) {
        const wd = (wj as any)?.description;
        if (typeof wd === "string") description = wd.trim() || null;
        else if (wd && typeof wd?.value === "string") description = String(wd.value).trim() || null;
      }
    }
  }

  // keep bounded
  subjects = subjects.slice(0, 60);

  return { description, subjects, raw: j };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const limit = Math.min(200, Math.max(10, Number(req.query.limit ?? 100)));
    const refreshMissing = String(req.query.refreshMissing ?? "") === "1";

    const rows = await prisma.libraryEntry.findMany({
      where: {
        userId: user.id,
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { authors: { contains: q, mode: "insensitive" } },
                { isbn: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      select: {
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
        meta: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // --- OPTIONAL: refresh missing subjects/description for a few entries ---
    // (limited to keep list fast)
    let attempted = 0;
    let updated = 0;

    if (refreshMissing) {
      const RowT = rows as unknown as Array<(typeof rows)[number]>;

      // Limit to avoid slow list calls
      const missing = RowT
        .filter((r: (typeof rows)[number]) => !r.subjects && !r.description)
        .slice(0, 3); // max 3 per request

      for (const r of missing) {
        const isbn = normalizeIsbn(r.isbn);
        if (!isbn) continue;

        attempted++;
        const meta = await fetchOpenLibraryMetaByIsbn(isbn);
        if (!meta) continue;

        const subjectsJson = meta.subjects.length ? JSON.stringify(meta.subjects) : null;
        const desc = meta.description ?? null;

        // Only write if we have something
        if (!subjectsJson && !desc) continue;

        await prisma.libraryEntry.update({
          where: { id: r.id },
          data: {
            subjects: subjectsJson ?? r.subjects,
            description: desc ?? r.description,
            meta: JSON.stringify(meta.raw),
          },
        });

        updated++;
      }
    }

    const entries = rows.map((r: (typeof rows)[number]) => ({
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
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return res.status(200).json({
      ok: true,
      entries,
      ...(refreshMissing ? { refreshed: { attempted, updated } } : {}),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
