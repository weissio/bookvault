import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Entry = {
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
};

type Data =
  | { ok: true; entries: Entry[] }
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

    const statusRaw = String(req.query.status ?? "all");
    const status =
      statusRaw === "unread" || statusRaw === "reading" || statusRaw === "read" ? statusRaw : "all";

    const ratingMinRaw = req.query.ratingMin;
    const ratingMaxRaw = req.query.ratingMax;

    const ratingMin =
      ratingMinRaw == null ? null : clamp(Number(ratingMinRaw), 1, 10);
    const ratingMax =
      ratingMaxRaw == null ? null : clamp(Number(ratingMaxRaw), 1, 10);

    const take = clamp(Number(req.query.take ?? 100), 1, 300);

    const where: any = { userId: user.id };

    if (status !== "all") where.status = status;

    if (ratingMin != null || ratingMax != null) {
      where.rating = {};
      if (ratingMin != null) where.rating.gte = ratingMin;
      if (ratingMax != null) where.rating.lte = ratingMax;
    }

    const rows = await prisma.libraryEntry.findMany({
      where,
      // Schema hat KEIN updatedAt -> createdAt nutzen
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
      },
    });

    type Row = (typeof rows)[number];

    const entries: Entry[] = rows.map((r: Row) => ({
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
    }));

    return res.status(200).json({ ok: true, entries });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
