import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import type { Prisma } from "@prisma/client";

type ExportEntry = {
  isbn: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  status: string;
  rating: number | null;
  notes: string | null;
  subjects: string | null;
  description: string | null;
  createdAt: string;
};

type Data =
  | { ok: true; exportedAt: string; entries: ExportEntry[] }
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

    // Wichtig: Kein updatedAt, kein meta
    const select = {
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
      select,
    });

    const entries: ExportEntry[] = rows.map((r) => ({
      isbn: r.isbn,
      title: r.title,
      authors: r.authors,
      coverUrl: r.coverUrl,
      status: r.status,
      rating: r.rating,
      notes: r.notes,
      subjects: r.subjects,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
    }));

    return res.status(200).json({
      ok: true,
      exportedAt: new Date().toISOString(),
      entries,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
