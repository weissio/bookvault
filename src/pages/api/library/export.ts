import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; exportedAt: string; user: { id: number; email: string }; entries: any[] }
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

async function requireUser(req: NextApiRequest) {
  const sessionId = getCookie(req, "bv_session");
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true, expiresAt: true },
  });

  if (!session) return null;

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true },
  });

  return user ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await requireUser(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not logged in" });

    const rows = await prisma.libraryEntry.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
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
        createdAt: true,
      },
    });

    // Export should be portable: remove internal numeric id
    const entries = rows.map((r) => ({
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

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bookvault_export_${new Date().toISOString().slice(0, 10)}.json"`
    );

    return res.status(200).json({
      ok: true,
      exportedAt: new Date().toISOString(),
      user,
      entries,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
