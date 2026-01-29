import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; deletedId: number }
  | { ok: false; error: string };

function getCookieFromHeader(rawCookieHeader: string | undefined, name: string): string | null {
  if (!rawCookieHeader) return null;
  const parts = rawCookieHeader.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) {
      return decodeURIComponent(p.slice(name.length + 1));
    }
  }
  return null;
}

function getSessionToken(req: NextApiRequest): string | null {
  // 1) Next.js parsed cookies
  const c: any = req.cookies || {};
  const direct =
    c.session ||
    c.sessionToken ||
    c.token ||
    c.bookvault_session ||
    c.bookvaultSession ||
    c.bv_session ||
    null;

  if (direct) return String(direct);

  // 2) Raw header fallback
  const raw = req.headers.cookie;
  const candidates = [
    "session",
    "sessionToken",
    "token",
    "bookvault_session",
    "bookvaultSession",
    "bv_session",
  ];

  for (const name of candidates) {
    const v = getCookieFromHeader(raw, name);
    if (v) return v;
  }

  return null;
}

async function getUserIdFromSessionToken(token: string): Promise<number | null> {
  // Wir wissen nicht, wie die Session-Tabelle genau heißt/spalten heißen.
  // Daher versuchen wir mehrere Varianten per SQL, bis eine klappt.

  // 1) token / sessionToken / id als String
  const attempts: Array<{ sql: string; args: any[] }> = [
    {
      sql: `SELECT userId as userId FROM Session WHERE token = ? LIMIT 1`,
      args: [token],
    },
    {
      sql: `SELECT userId as userId FROM Session WHERE sessionToken = ? LIMIT 1`,
      args: [token],
    },
    {
      sql: `SELECT userId as userId FROM Session WHERE id = ? LIMIT 1`,
      args: [token],
    },
    // manche nennen die Spalte einfach "value"
    {
      sql: `SELECT userId as userId FROM Session WHERE value = ? LIMIT 1`,
      args: [token],
    },
  ];

  for (const a of attempts) {
    try {
      const rows: any[] = await (prisma as any).$queryRawUnsafe(a.sql, ...a.args);
      const row = rows?.[0];
      if (row && row.userId != null) {
        const n = Number(row.userId);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      // ignorieren: Spalte existiert evtl. nicht
    }
  }

  return null;
}

async function requireUser(req: NextApiRequest) {
  const token = getSessionToken(req);
  if (!token) return null;

  const userId = await getUserIdFromSessionToken(token);
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  return user ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const user = await requireUser(req);
    if (!user) return res.status(401).json({ ok: false, error: "Not authenticated" });

    const entryIdRaw = req.body?.id ?? req.body?.entryId;
    const entryId = Number(entryIdRaw);

    if (!Number.isFinite(entryId) || entryId <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid id" });
    }

    const result = await prisma.libraryEntry.deleteMany({
      where: { id: entryId, userId: user.id },
    });

    if (result.count === 0) {
      return res.status(404).json({ ok: false, error: "Entry not found (or not yours)" });
    }

    return res.status(200).json({ ok: true, deletedId: entryId });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Server error" });
  }
}
