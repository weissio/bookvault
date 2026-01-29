import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";

type Data =
  | {
      ok: true;
      entries: Array<{
        id: number;
        userId: number;
        isbn: string;
        title: string;
        authors: string;
        coverUrl: string | null;
        status: string;
        rating: number | null;
        notes: string | null;
        subjects: string | null;
        description: string | null;
        createdAt: string;
      }>;
      metaRefresh?: {
        attempted: number;
        updated: number;
      };
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Not logged in" });

    // 1) Load entries
    const rows = await prisma.libraryEntry.findMany({
      where: { userId },
      orderBy: { id: "desc" },
      select: {
        id: true,
        userId: true,
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

    // 2) Auto-refresh missing meta (best effort)
    // Limit to avoid slow list calls
    const missing = rows
      .filter((r) => !r.subjects && !r.description)
      .slice(0, 3); // <- max 3 per request

    let attempted = 0;
    let updated = 0;

    for (const m of missing) {
      attempted += 1;
      try {
        const meta = await fetchOpenLibraryMetaByIsbn(m.isbn);
        const subjectsJson = meta.subjects ? JSON.stringify(meta.subjects) : null;
        const description = meta.description ?? null;

        if (subjectsJson || description) {
          await prisma.libraryEntry.update({
            where: { id: m.id },
            data: { subjects: subjectsJson, description },
          });
          updated += 1;

          // also patch the in-memory row so UI gets it immediately
          (m as any).subjects = subjectsJson;
          (m as any).description = description;
        }
      } catch {
        // ignore
      }
    }

    const entries = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    return res.status(200).json({
      ok: true,
      entries,
      metaRefresh: { attempted, updated },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
