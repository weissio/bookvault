import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type ExportEntry = {
  isbn: string | null;
  title: string | null;
  authors: string | null;
  coverUrl: string | null;
  status: string | null;
  rating: number | null;
  notes: string | null;
  subjects: string | null;
  meta: string | null;
  createdAt: string;
  updatedAt: string;
};

type Data =
  | { ok: true; entries: ExportEntry[] }
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

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    const rows = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        // internal id intentionally not exported
        isbn: true,
        title: true,
        authors: true,
        coverUrl: true,
        status: true,
        rating: true,
        notes: true,
        subjects: true,
        meta: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Make export portable: no internal numeric ids, dates as ISO strings
    const entries: ExportEntry[] = rows.map((r: typeof rows[number]) => ({
      isbn: r.isbn,
      title: r.title,
      authors: r.authors,
      coverUrl: r.coverUrl,
      status: r.status,
      rating: r.rating,
      notes: r.notes,
      subjects: r.subjects,
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return res.status(200).json({ ok: true, entries });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
