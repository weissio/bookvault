import { useEffect, useMemo, useRef, useState } from "react";

type MeResponse =
  | { ok: true; user: { id: number; email: string } | null }
  | { ok: false; error: string };

type SearchItem = {
  isbn?: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  description?: string;
  canSave?: boolean;
};

type SearchResponse = { ok: true; results: SearchItem[] } | { ok: false; error: string };

type AddResponse = { ok: true; entry: any } | { ok: false; error: string };
type BlockResponse = { ok: true; id: number } | { ok: false; error: string };

type AuthResponse =
  | { ok: true; user: { id: number; email: string } }
  | { ok: false; error: string };

type Toast = { id: string; text: string; kind: "success" | "error" | "info" };

function nowId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function HomePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const user = useMemo(() => (me && (me as any).ok ? (me as any).user : null), [me]);

  // auth ui
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authWorking, setAuthWorking] = useState(false);

  // search
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [expandedSearchDesc, setExpandedSearchDesc] = useState<Record<string, boolean>>({});
  const [blockLoading, setBlockLoading] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  // bulk add
  const [bulkText, setBulkText] = useState("");
  const [bulkWorking, setBulkWorking] = useState(false);

  // toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimer = useRef<Record<string, any>>({});

  function pushToast(kind: Toast["kind"], text: string, ms = 2400) {
    const id = nowId();
    const t: Toast = { id, kind, text };
    setToasts((prev) => [t, ...prev].slice(0, 3));
    if (toastTimer.current[id]) clearTimeout(toastTimer.current[id]);
    toastTimer.current[id] = setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
      delete toastTimer.current[id];
    }, ms);
  }

  async function refreshMe() {
    try {
      const r = await fetch("/api/auth/me");
      const j = (await r.json()) as MeResponse;
      setMe(j);
    } catch {
      setMe({ ok: false, error: "Konnte Session nicht prüfen." });
    }
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  async function doAuth() {
    setMsg(null);
    const email = authEmail.trim();
    const password = authPassword;

    if (!email || !password) {
      pushToast("info", "Bitte Email und Passwort eingeben.");
      return;
    }

    setAuthWorking(true);
    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = (await r.json()) as AuthResponse;

      if (!j.ok) {
        pushToast("error", j.error || "Auth fehlgeschlagen.");
        return;
      }

      pushToast("success", authMode === "login" ? "Eingeloggt ✓" : "Account erstellt ✓");
      setAuthPassword("");
      await refreshMe();
    } catch (e: any) {
      pushToast("error", e?.message ?? "Auth fehlgeschlagen.");
    } finally {
      setAuthWorking(false);
    }
  }

  async function doLogout() {
    setMsg(null);
    setAuthWorking(true);
    try {
      const r = await fetch("/api/auth/logout", { method: "POST" });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        pushToast("error", j.error || "Logout fehlgeschlagen.");
        return;
      }
      pushToast("success", "Ausgeloggt ✓");
      setResults([]);
      setBulkText("");
      await refreshMe();
    } catch (e: any) {
      pushToast("error", e?.message ?? "Logout fehlgeschlagen.");
    } finally {
      setAuthWorking(false);
    }
  }

  async function doSearch() {
    setMsg(null);
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const j = (await r.json()) as SearchResponse;
      if (!j.ok) {
        setMsg(j.error || "Suche fehlgeschlagen.");
        setResults([]);
        return;
      }
      setResults(j.results || []);
    } catch (e: any) {
      setMsg(e?.message ?? "Unbekannter Fehler");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function saveBook(item: SearchItem) {
    setMsg(null);
    if (!user) {
      pushToast("info", "Bitte einloggen, um Bücher zu speichern.");
      return;
    }
    if (!item.isbn) {
      pushToast("info", "Ohne ISBN kann ich das Buch noch nicht speichern.");
      return;
    }
    try {
      const r = await fetch("/api/library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isbn: item.isbn,
          title: item.title,
          authors: item.authors,
          coverUrl: item.coverUrl,
          status: "unread",
          rating: null,
        }),
      });
      const j = (await r.json()) as AddResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Speichern fehlgeschlagen.");
        return;
      }
      pushToast("success", `Gespeichert ✓  ${item.title}`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Speichern fehlgeschlagen.");
    }
  }


  async function blockItem(item: SearchItem) {
    if (!user) {
      pushToast("info", "Bitte einloggen, um Bücher auszublenden.");
      return;
    }

    const key = item.isbn || `${item.title}-${item.authors}`;
    setBlockLoading((p) => ({ ...p, [key]: true }));
    try {
      const r = await fetch("/api/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isbn: item.isbn || "",
          title: item.title,
          authors: item.authors,
        }),
      });

      const j = (await r.json()) as BlockResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Ausblenden fehlgeschlagen.");
        return;
      }

      setResults((prev) => prev.filter((x) => (x.isbn || `${x.title}-${x.authors}`) !== key));
      pushToast("success", `Ausgeblendet ✓  ${item.title}`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Ausblenden fehlgeschlagen.");
    } finally {
      setBlockLoading((p) => ({ ...p, [key]: false }));
    }
  }

  function parseBulkLines(text: string): string[] {
    return text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 200);
  }

  async function bulkAdd() {
    setMsg(null);
    if (!user) {
      pushToast("info", "Bitte einloggen, um Bücher zu speichern.");
      return;
    }
    const lines = parseBulkLines(bulkText);
    if (lines.length === 0) return;

    setBulkWorking(true);
    let okCount = 0;
    let failCount = 0;

    try {
      for (const line of lines) {
        try {
          const r = await fetch(`/api/search?q=${encodeURIComponent(line)}`);
          const j = (await r.json()) as SearchResponse;
          if (!j.ok || !j.results?.length) {
            failCount++;
            continue;
          }
          // best guess: first result
          const pick = j.results[0];
          if (!pick?.isbn) {
            failCount++;
            continue;
          }
          const r2 = await fetch("/api/library/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              isbn: pick.isbn,
              title: pick.title,
              authors: pick.authors,
              coverUrl: pick.coverUrl,
              status: "unread",
              rating: null,
            }),
          });
          const j2 = (await r2.json()) as AddResponse;
          if (!j2.ok) {
            failCount++;
            continue;
          }
          okCount++;
        } catch {
          failCount++;
        }
      }

      if (okCount > 0) pushToast("success", `Bulk-Add fertig ✓  Gespeichert: ${okCount}`);
      if (failCount > 0) pushToast("info", `Nicht gefunden/fehlgeschlagen: ${failCount}`);
    } finally {
      setBulkWorking(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span style={{ opacity: 0.85 }}>{t.kind === "success" ? "✅ " : t.kind === "error" ? "⚠️ " : "ℹ️ "}</span>
            {t.text}
          </div>
        ))}
      </div>

      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Buchsuche</h1>
            <p className="page-subtitle">Neue Bücher finden und direkt in die Bibliothek legen.</p>
          </div>

          <div style={{ textAlign: "right", minWidth: 330 }}>
            <div className="nav-links">
              <a className="nav-pill primary" href="/library">
                Bibliothek
              </a>
              <a className="nav-pill" href="/recommendations">
                Empfehlungen
              </a>
              <a className="nav-pill" href="/blocklist">
                Sperrliste
              </a>
            </div>

            <div className="panel" style={{ marginTop: 12, padding: 14 }}>
              {user ? (
                <>
                  <div className="panel-title">Eingeloggt</div>
                  <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
                  <button
                    type="button"
                    onClick={() => void doLogout()}
                    disabled={authWorking}
                    className="btn btn-ghost"
                  >
                    {authWorking ? "…" : "Logout"}
                  </button>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setAuthMode("login")}
                      className="btn"
                      style={{ flex: 1, background: authMode === "login" ? "var(--accent-soft)" : undefined }}
                    >
                      Login
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthMode("register")}
                      className="btn"
                      style={{ flex: 1, background: authMode === "register" ? "var(--accent-soft)" : undefined }}
                    >
                      Registrieren
                    </button>
                  </div>

                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="Email"
                    autoComplete="email"
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />

                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Passwort"
                    type="password"
                    autoComplete={authMode === "login" ? "current-password" : "new-password"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doAuth();
                    }}
                    style={{ padding: "10px 12px", borderRadius: 10 }}
                  />

                  <button
                    type="button"
                    onClick={() => void doAuth()}
                    disabled={authWorking}
                    className="btn"
                  >
                    {authWorking ? "…" : authMode === "login" ? "Einloggen" : "Account erstellen"}
                  </button>

                  <div style={{ fontSize: 12 }} className="muted">
                    {authMode === "login"
                      ? "Login nutzt deine bestehende Session."
                      : "Registrieren erstellt einen neuen Account und loggt dich ein."}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {msg && (
          <div className="panel">
            <div className="muted">{msg}</div>
          </div>
        )}

        <div className="panel" style={{ marginTop: 18 }}>
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ fontWeight: 800 }}>ISBN, Titel oder Autor</label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doSearch();
                }}
                style={{ flex: 1, minWidth: 260, padding: "10px 12px", borderRadius: 10 }}
                placeholder="z.B. Max Frisch, Der Steppenwolf, 978…"
              />
              <button onClick={() => void doSearch()} className="btn">
                Suchen
              </button>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-title">
            <span>Suchergebnisse</span>
            <span className="section-meta">{loading ? "Lädt…" : `${results.length} Treffer`}</span>
          </div>

          <div className="books-grid">
            {results.map((r) => (
              <div key={r.isbn || `${r.title}-${r.authors}`} className="book-card">
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {r.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.coverUrl}
                      alt=""
                      width={56}
                      height={82}
                      style={{ borderRadius: 10, objectFit: "cover", boxShadow: "0 6px 14px rgba(0,0,0,0.15)" }}
                    />
                  ) : (
                    <div style={{ width: 56, height: 82, borderRadius: 10, border: "1px dashed var(--line)", opacity: 0.6 }} />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800 }}>{r.title}</div>
                    <div className="muted">{r.authors}</div>
                    {r.description ? (
                      <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>
                        {(() => {
                          const key = r.isbn || `${r.title}-${r.authors}`;
                          const isOpen = !!expandedSearchDesc[key];
                          const short = r.description.slice(0, 220);
                          const show = isOpen ? r.description : short;
                          return (
                            <>
                              {show}
                              {!isOpen && r.description.length > 220 ? "…" : ""}
                              {r.description.length > 220 ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedSearchDesc((p) => ({ ...p, [key]: !p[key] }))}
                                  style={{
                                    border: "none",
                                    background: "transparent",
                                    color: "inherit",
                                    textDecoration: "underline",
                                    cursor: "pointer",
                                    fontWeight: 800,
                                    opacity: 0.9,
                                    padding: 0,
                                    marginLeft: 6,
                                  }}
                                >
                                  {isOpen ? "Weniger" : "Mehr"}
                                </button>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                    <div style={{ opacity: 0.65, fontSize: 12 }}>ISBN: {r.isbn ? r.isbn : "—"}</div>
                  </div>

                  <div style={{ display: "grid", gap: 8, minWidth: 120 }}>
                    <button
                      onClick={() => void saveBook(r)}
                      disabled={!user || !r.isbn}
                      className="btn"
                      style={{ opacity: user ? 1 : 0.7 }}
                      title={!r.isbn ? "Ohne ISBN nicht speicherbar" : user ? "In deine Bibliothek speichern" : "Bitte einloggen"}
                    >
                      {!r.isbn ? "Keine ISBN" : "Speichern"}
                    </button>
                    <button
                      onClick={() => void blockItem(r)}
                      disabled={!user}
                      className="btn btn-ghost"
                      style={{ opacity: user ? 0.9 : 0.6 }}
                      title={user ? "Ausblenden" : "Bitte einloggen"}
                    >
                      {blockLoading[r.isbn || `${r.title}-${r.authors}`] ? "…" : "Ausblenden"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel" style={{ marginTop: 18, opacity: user ? 1 : 0.85 }}>
          <div style={{ fontWeight: 800 }}>Bulk-Add (optional)</div>
          <div style={{ fontSize: 12 }} className="muted">
            Eine Zeile pro Buch (Titel oder ISBN). Speichert automatisch den besten Treffer.
          </div>

          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={6}
            placeholder={`Beispiel:\nDer Schatten des Windes\n9783832165987\nThe Rosie Project`}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10, marginTop: 8 }}
          />

          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            <div style={{ fontSize: 12 }} className="muted">
              Zeilen: {parseBulkLines(bulkText).length}
            </div>
            <button
              disabled={bulkWorking}
              onClick={() => void bulkAdd()}
              className="btn"
              title={user ? "Bulk speichern" : "Bitte einloggen"}
            >
              {bulkWorking ? "Speichert…" : "Bulk speichern"}
            </button>
          </div>

          {!user && (
            <div style={{ fontSize: 12, marginTop: 8 }} className="muted">
              Hinweis: Speichern funktioniert erst nach Login/Registrierung (oben rechts).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
