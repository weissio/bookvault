import { useEffect, useMemo, useState } from "react";

type MeResponse =
  | { ok: true; user: { id: number; email: string } | null }
  | { ok: false; error: string };

type BlockItem = {
  id: number;
  title: string;
  authors: string;
  isbn: string;
  workKey: string;
  createdAt: string;
};

type BlockListResponse =
  | { ok: true; items: BlockItem[] }
  | { ok: false; error: string };

type DeleteResponse =
  | { ok: true; id: number }
  | { ok: false; error: string };

export default function BlocklistPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const user = useMemo(() => (me && (me as any).ok ? (me as any).user : null), [me]);

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<BlockItem[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function refreshMe() {
    const r = await fetch("/api/auth/me");
    const j = (await r.json()) as MeResponse;
    setMe(j);
  }

  async function load() {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/blocklist");
      const j = (await r.json()) as BlockListResponse;
      if (!j.ok) {
        setMsg(j.error || "Konnte Sperrliste nicht laden.");
        setItems([]);
        return;
      }
      setItems(j.items || []);
    } catch (e: any) {
      setMsg(e?.message ?? "Unbekannter Fehler");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user]);

  async function removeItem(id: number) {
    try {
      const r = await fetch("/api/blocklist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = (await r.json()) as DeleteResponse;
      if (!j.ok) {
        setMsg(j.error || "Entfernen fehlgeschlagen.");
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e: any) {
      setMsg(e?.message ?? "Entfernen fehlgeschlagen.");
    }
  }

  if (me && (me as any).ok && !user) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 980 }}>
          <h1 style={{ fontSize: 28, marginBottom: 6 }}>Sperrliste</h1>
          <p style={{ opacity: 0.85, marginTop: 0 }}>
            Dafür brauchst du einen Account.
          </p>
          <div style={{ marginTop: 16 }}>
            <a href="/" style={{ textDecoration: "underline" }}>
              ← Zur Startseite (Login)
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 980 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 28, marginBottom: 6 }}>Sperrliste</h1>
            <p style={{ marginTop: 0, opacity: 0.85 }}>Hier kannst du ausgeblendete Bücher wieder erlauben.</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <a href="/recommendations" style={{ textDecoration: "underline" }}>
              ← Empfehlungen
            </a>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>{user ? user.email : ""}</div>
          </div>
        </div>

        {msg && <div style={{ marginTop: 10, opacity: 0.9 }}>{msg}</div>}

        <div style={{ marginTop: 16, opacity: 0.85 }}>
          {loading ? "Lädt…" : `Einträge (${items.length})`}
        </div>

        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {items.map((x) => (
            <div
              key={x.id}
              style={{
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 900 }}>{x.title || "(ohne Titel)"}</div>
                <div style={{ opacity: 0.85 }}>{x.authors || "—"}</div>
                <div style={{ opacity: 0.65, fontSize: 12 }}>ISBN: {x.isbn || "—"}</div>
              </div>
              <button
                onClick={() => void removeItem(x.id)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
                title="Aus Sperrliste entfernen"
              >
                Entfernen
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
