import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true }
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

function clearCookie(name: string) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
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
    const sessionId = getCookie(req, "bv_session");
    if (sessionId) {
      await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    }

    res.setHeader("Set-Cookie", clearCookie("bv_session"));
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
