import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data = | { ok: true; entry: any } | { ok: false; error: string };

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

function isValidStatus(s: string) {
  return s === "unread" || s === "reading" || s === "paused" || s === "read";
}

function parseRating(raw: any): number | null | undefined {
  // undefined => do not touch rating
  // null      => clear rating
  // number    => set rating (1..10)
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;

  // allow only integers 1..10
  const i = Math.trunc(n);
  if (i !== n) return undefined;
  if (i < 1 || i > 10) return undefined;

  return i;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const userId = await requireUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Not logged in" });
    }

    const { entryId, status, rating, notes } = req.body ?? {};

    if (entryId === undefined || entryId === null) {
      return res.status(400).json({ ok: false, error: "Missing entryId" });
    }

    const id = Number(entryId);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid entryId" });
    }

    const existing = await prisma.libraryEntry.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Entry not found" });
    }

    if (existing.userId !== userId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const data: any = {};

    if (status !== undefined) {
      const s = String(status);
      if (!isValidStatus(s)) {
        return res.status(400).json({ ok: false, error: "Invalid status" });
      }
      data.status = s;
    }

    const parsedRating = parseRating(rating);
    if (rating !== undefined) {
      // rating was provided, but invalid (e.g. 0, 11, float, NaN, etc.)
      if (parsedRating === undefined) {
        return res.status(400).json({ ok: false, error: "Invalid rating (allowed: 1..10 or null)" });
      }
      data.rating = parsedRating; // number 1..10 or null
    }

    if (notes !== undefined) {
      data.notes = notes === null ? null : String(notes);
    }

    // If nothing to update, return current entry
    if (Object.keys(data).length === 0) {
      const entry = await prisma.libraryEntry.findUnique({ where: { id } });
      return res.status(200).json({ ok: true, entry });
    }

    const entry = await prisma.libraryEntry.update({ where: { id }, data });

    try {
      const becameRead = data.status === "read";
      const hasRating = typeof data.rating === "number" && data.rating >= 1;
      if (becameRead && hasRating) {
        const full = await prisma.libraryEntry.findUnique({
          where: { id },
          select: { isbn: true, title: true, authors: true },
        });
        if (full) {
          const keyCandidates = [
            `isbn:${String(full.isbn || "").trim()}`,
            fallbackKey(String(full.title || ""), String(full.authors || ""), String(full.isbn || "")),
          ].filter((x) => x && !x.endsWith(":"));

          const saved = await prisma.recommendationEvent.findFirst({
            where: {
              userId,
              event: "saved_from_recommendation",
              workKey: { in: keyCandidates },
            },
            orderBy: { createdAt: "desc" },
          });

          if (saved) {
            const exists = await prisma.recommendationEvent.findFirst({
              where: {
                userId,
                event: "finished_from_recommendation",
                workKey: saved.workKey,
              },
            });
            if (!exists) {
              await prisma.recommendationEvent.create({
                data: {
                  userId,
                  workKey: saved.workKey,
                  event: "finished_from_recommendation",
                  valueJson: { rating: data.rating },
                },
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return res.status(200).json({ ok: true, entry });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
