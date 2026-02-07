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
      <div className="app-shell">
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Sperrliste</h1>
              <p className="page-subtitle">Dafür brauchst du einen Account.</p>
            </div>
            <div className="nav-links">
              <a className="nav-pill" href="/">
                Startseite
              </a>
            </div>
          </header>

          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">Login erforderlich</div>
            <div className="muted" style={{ marginTop: 6 }}>
              Bitte anmelden, um die Sperrliste zu sehen.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Sperrliste</h1>
            <p className="page-subtitle">Hier kannst du ausgeblendete Bücher wieder erlauben.</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="nav-links">
              <a className="nav-pill" href="/library">
                Bibliothek
              </a>
              <a className="nav-pill" href="/recommendations">
                Empfehlungen
              </a>
            </div>
            <div style={{ marginTop: 8, fontSize: 12 }} className="muted">
              {user ? user.email : ""}
            </div>
          </div>
        </header>

        {msg && (
          <div className="panel">
            <div className="muted">{msg}</div>
          </div>
        )}

        <div className="section">
          <div className="section-title">
            <span>Gesperrte Bücher</span>
            <span className="section-meta">{loading ? "Lädt…" : `${items.length} Einträge`}</span>
          </div>

          <div className="books-grid">
            {items.map((x) => (
              <div key={x.id} className="book-card">
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800 }}>{x.title || "(ohne Titel)"}</div>
                    <div className="muted">{x.authors || "—"}</div>
                    <div style={{ opacity: 0.65, fontSize: 12 }}>ISBN: {x.isbn || "—"}</div>
                  </div>
                  <button onClick={() => void removeItem(x.id)} className="btn btn-ghost" title="Aus Sperrliste entfernen">
                    Entfernen
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
