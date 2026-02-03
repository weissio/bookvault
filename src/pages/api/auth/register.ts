import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import bcrypt from "bcryptjs";

type Data =
  | { ok: true }
  | { ok: false; error: string };

function setCookie(
  res: NextApiResponse,
  name: string,
  value: string,
  maxAgeSeconds: number
) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Ungültige E-Mail." });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ ok: false, error: "Passwort muss mind. 8 Zeichen haben." });
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      return res.status(409).json({ ok: false, error: "E-Mail ist bereits registriert." });
    }

    const passHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passHash,
      },
      select: { id: true },
    });

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    await prisma.session.create({
      data: {
        token: sessionId,
        userId: user.id,
        expiresAt,
      },
    });

    setCookie(res, "bv_session", sessionId, 60 * 60 * 24 * 30);
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Serverfehler" });
  }
}
