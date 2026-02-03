import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; user: { id: number; email: string } | null }
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const sessionId = getCookie(req, "bv_session");
    if (!sessionId) {
      return res.status(200).json({ ok: true, user: null });
    }

    const session = await prisma.session.findUnique({
      where: { token: sessionId },
      select: { userId: true, expiresAt: true },
    });

    if (!session) {
      return res.status(200).json({ ok: true, user: null });
    }

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      // session expired; optionally clean it up
      await prisma.session.delete({ where: { token: sessionId } }).catch(() => {});
      return res.status(200).json({ ok: true, user: null });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true },
    });

    return res.status(200).json({ ok: true, user: user ?? null });
  } catch (e: any) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
