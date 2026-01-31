import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

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
        meta: string | null;
        createdAt: string;
      }>;
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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    // Optional filters
    const statusRaw = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const ratingRaw = typeof req.query.rating === "string" ? req.query.rating.trim() : "";
    const take = clamp(Number(req.query.take ?? 100), 1, 300);

    const where: any = { userId: user.id };

    // Status filter (if provided and not "all")
    if (statusRaw && statusRaw !== "all") {
      where.status = statusRaw;
    }

    // Rating filter:
    // - "all" or empty -> no filter
    // - "rated" -> rating not null
    // - "unrated" -> rating is null
    // - number -> rating equals that number
    if (ratingRaw && ratingRaw !== "all") {
      if (ratingRaw === "rated") where.rating = { not: null };
      else if (ratingRaw === "unrated") where.rating = null;
      else {
        const n = Number(ratingRaw);
        if (!Number.isNaN(n)) where.rating = n;
      }
    }

    const rows = await prisma.libraryEntry.findMany({
      where,
      // WICHTIG: Schema hat kein updatedAt -> sortiere nach createdAt
      orderBy: [{ createdAt: "desc" }],
      take,
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
        // updatedAt: true,  // <- NICHT vorhanden im Schema
      },
    });

    const entries = rows.map((r) => ({
      id: r.id,
      isbn: r.isbn,
      title: r.title,
      authors: r.authors,
      coverUrl: r.coverUrl ?? null,
      status: r.status,
      rating: typeof r.rating === "number" ? r.rating : null,
      notes: r.notes ?? null,
      subjects: r.subjects ?? null,
      description: r.description ?? null,
      meta: r.meta ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    return res.status(200).json({ ok: true, entries });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
