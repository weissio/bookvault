import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | { ok: true; entry: any }
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
    where: { id: sessionId },
    select: { userId: true, expiresAt: true },
  });

  if (!session) return null;

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }

  return session.userId;
}

function normalizeDescription(desc: any): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc.trim() || null;
  if (typeof desc === "object" && typeof desc.value === "string") {
    const v = desc.value.trim();
    return v || null;
  }
  return null;
}

function uniqueTop(arr: string[], limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const v = String(s || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

async function safeJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

async function fetchOpenLibraryMetaByIsbn(isbn: string) {
  const clean = isbn.replace(/[^0-9Xx]/g, "");
  if (!clean) return { subjects: null as string[] | null, description: null as string | null };

  const editionUrl = `https://openlibrary.org/isbn/${encodeURIComponent(clean)}.json`;
  const edition = await safeJson(editionUrl);

  let workKey: string | null = null;
  if (edition?.works?.[0]?.key && typeof edition.works[0].key === "string") {
    workKey = edition.works[0].key;
  }

  let work: any = null;
  if (workKey) work = await safeJson(`https://openlibrary.org${workKey}.json`);

  const subjectsRawWork: string[] = Array.isArray(work?.subjects) ? work.subjects : [];
  const subjectsRawEdition: string[] = Array.isArray(edition?.subjects) ? edition.subjects : [];

  const subjects = uniqueTop(
    subjectsRawWork.length ? subjectsRawWork : subjectsRawEdition,
    20
  );

  const description =
    normalizeDescription(work?.description) ??
    normalizeDescription(edition?.description) ??
    null;

  return {
    subjects: subjects.length ? subjects : null,
    description,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Not logged in" });

    const { entryId } = req.body ?? {};
    const id = Number(entryId);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid entryId" });
    }

    const entry = await prisma.libraryEntry.findUnique({
      where: { id },
      select: { id: true, userId: true, isbn: true },
    });

    if (!entry) return res.status(404).json({ ok: false, error: "Entry not found" });
    if (entry.userId !== userId) return res.status(403).json({ ok: false, error: "Forbidden" });

    const meta = await fetchOpenLibraryMetaByIsbn(entry.isbn);
    const subjectsJson = meta.subjects ? JSON.stringify(meta.subjects) : null;
    const description = meta.description ?? null;

    const updated = await prisma.libraryEntry.update({
      where: { id },
      data: {
        subjects: subjectsJson,
        description,
      },
    });

    return res.status(200).json({ ok: true, entry: updated });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
