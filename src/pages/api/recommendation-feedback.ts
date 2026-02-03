import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; key: string; action: "like" | "dislike" }
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    const actionRaw = String(req.body?.action || "").trim();
    const action = actionRaw === "like" || actionRaw === "dislike" ? actionRaw : null;
    if (!action) return res.status(400).json({ ok: false, error: "Invalid action" });

    const recId = String(req.body?.recId || "").trim();
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

    const event = action === "like" ? "pref_like" : "pref_dislike";

    await prisma.recommendationEvent.create({
      data: {
        userId: user.id,
        workKey: key,
        event,
        valueJson: {
          recId,
          title,
          authors,
          isbn,
          action,
        },
      },
    });

    return res.status(200).json({ ok: true, key, action });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
