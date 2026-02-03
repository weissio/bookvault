import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | {
      ok: true;
      imported: number;
      updated: number;
      skipped: number;
      totalInFile: number;
    }
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

function toStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toNumOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Not logged in" });

    // Expect body: { entries: [...] }  OR full export JSON { ok:true, entries:[...] }
    const body = req.body ?? {};
    const entries = Array.isArray(body.entries) ? body.entries : null;

    if (!entries) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid payload. Expected JSON with "entries": [...]',
      });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of entries) {
      const isbn = toStr(raw?.isbn);
      const title = toStr(raw?.title);
      const authors = toStr(raw?.authors);

      if (!isbn || !title || !authors) {
        skipped += 1;
        continue;
      }

      const coverUrl = toStr(raw?.coverUrl);
      const status = toStr(raw?.status) ?? "unread";
      const rating = toNumOrNull(raw?.rating);
      const notes = toStr(raw?.notes);

      const subjects = toStr(raw?.subjects);
      const description = toStr(raw?.description);

      const existing = await prisma.libraryEntry.findFirst({
        where: { userId, isbn },
        select: { id: true },
      });

      if (existing) {
        // Update only if file has values (do not overwrite existing with null)
        const data: any = {
          title,
          authors,
          coverUrl: coverUrl ?? undefined,
          status,
          rating,
          notes: notes ?? undefined,
          subjects: subjects ?? undefined,
          description: description ?? undefined,
        };

        await prisma.libraryEntry.update({
          where: { id: existing.id },
          data,
        });

        updated += 1;
      } else {
        await prisma.libraryEntry.create({
          data: {
            userId,
            isbn,
            title,
            authors,
            coverUrl,
            status,
            rating,
            notes,
            subjects,
            description,
          },
        });

        imported += 1;
      }
    }

    return res.status(200).json({
      ok: true,
      imported,
      updated,
      skipped,
      totalInFile: entries.length,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
