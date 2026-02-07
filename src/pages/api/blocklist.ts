import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; items: Array<{ id: number; title: string; authors: string; isbn: string; workKey: string; createdAt: string }> }
  | { ok: true; id: number }
  | { ok: false; error: string };

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

async function getUserFromRequest(req: NextApiRequest) {
  const token = req.cookies?.bv_session || null;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token: String(token) },
    select: { userId: true, expiresAt: true },
  });

  if (!session) return null;
  if (session.expiresAt && session.expiresAt <= new Date()) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true },
  });

  return user;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    if (req.method === "GET") {
      const rows = await prisma.recommendationEvent.findMany({
        where: { userId: user.id, event: "blocked" },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, workKey: true, valueJson: true, createdAt: true },
      });

      const items = rows.map((r) => {
        const v = (r.valueJson as any) || {};
        return {
          id: r.id,
          workKey: r.workKey,
          title: String(v.title || ""),
          authors: String(v.authors || ""),
          isbn: String(v.isbn || ""),
          createdAt: r.createdAt.toISOString(),
        };
      });

      return res.status(200).json({ ok: true, items });
    }

    if (req.method === "POST") {
      const title = String(req.body?.title || "").trim();
      const authors = String(req.body?.authors || "").trim();
      const isbn = String(req.body?.isbn || "").trim();
      const workKey = String(req.body?.workKey || "").trim();

      let key = "";
      if (workKey) {
        key = workKey.startsWith("/") ? `ol:${workKey}` : workKey;
      } else {
        key = fallbackKey(title, authors, isbn);
      }

      const row = await prisma.recommendationEvent.create({
        data: {
          userId: user.id,
          workKey: key,
          event: "blocked",
          valueJson: { title, authors, isbn },
        },
        select: { id: true },
      });

      return res.status(200).json({ ok: true, id: row.id });
    }

    if (req.method === "DELETE") {
      const id = Number(req.body?.id || 0);
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      await prisma.recommendationEvent.delete({ where: { id } });
      return res.status(200).json({ ok: true, id });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    if (e?.code === "P2021") {
      return res.status(503).json({ ok: false, error: "Feedback-Tabelle fehlt. Bitte Migration ausfuehren." });
    }
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
