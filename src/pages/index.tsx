import { useEffect, useMemo, useRef, useState } from "react";

type MeResponse =
  | { ok: true; user: { id: number; email: string } | null }
  | { ok: false; error: string };

type SearchItem = {
  isbn: string;
  title: string;
  authors: string;
  coverUrl: string | null;
};

type SearchResponse = { ok: true; results: SearchItem[] } | { ok: false; error: string };

type AddResponse = { ok: true; entry: any } | { ok: false; error: string };

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
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 24 }}>
      {/* Toasts */}
      <div
        style={{
          position: "fixed",
          top: 14,
          right: 14,
          zIndex: 9999,
          display: "grid",
          gap: 8,
          width: 360,
          maxWidth: "92vw",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(6px)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
              fontWeight: 800,
              opacity: 0.98,
            }}
          >
            <span style={{ opacity: 0.85 }}>{t.kind === "success" ? "✅ " : t.kind === "error" ? "⚠️ " : "ℹ️ "}</span>
            {t.text}
          </div>
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 980 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 28, marginBottom: 6 }}>Meine Bibliothek</h1>
            <p style={{ marginTop: 0, opacity: 0.85 }}>
              Suche nach ISBN, Titel oder Autor – speichere Treffer in deine Bibliothek.
            </p>
          </div>

          <div style={{ textAlign: "right", minWidth: 330 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <a href="/library" style={{ textDecoration: "underline" }}>
                Zur Bibliothek
              </a>
              <a href="/recommendations" style={{ textDecoration: "underline" }}>
                Empfehlungen
              </a>
            </div>

            {/* Auth panel */}
            <div
              style={{
                marginTop: 10,
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                display: "grid",
                gap: 10,
              }}
            >
              {user ? (
                <>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Eingeloggt als</div>
                  <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {user.email}
                  </div>
                  <button
                    type="button"
                    onClick={() => void doLogout()}
                    disabled={authWorking}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: authWorking ? "rgba(255,255,255,0.08)" : "transparent",
                      cursor: authWorking ? "default" : "pointer",
                      fontWeight: 900,
                    }}
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
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: authMode === "login" ? "rgba(255,255,255,0.08)" : "transparent",
                        cursor: "pointer",
                        fontWeight: 900,
                        flex: 1,
                      }}
                    >
                      Login
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthMode("register")}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: authMode === "register" ? "rgba(255,255,255,0.08)" : "transparent",
                        cursor: "pointer",
                        fontWeight: 900,
                        flex: 1,
                      }}
                    >
                      Registrieren
                    </button>
                  </div>

                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="Email"
                    autoComplete="email"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "inherit",
                    }}
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
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "inherit",
                    }}
                  />

                  <button
                    type="button"
                    onClick={() => void doAuth()}
                    disabled={authWorking}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: authWorking ? "rgba(255,255,255,0.08)" : "transparent",
                      cursor: authWorking ? "default" : "pointer",
                      fontWeight: 900,
                    }}
                  >
                    {authWorking ? "…" : authMode === "login" ? "Einloggen" : "Account erstellen"}
                  </button>

                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {authMode === "login"
                      ? "Login nutzt deine bestehende Session."
                      : "Registrieren erstellt einen neuen Account und loggt dich ein."}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {msg && <div style={{ marginTop: 10, opacity: 0.9 }}>{msg}</div>}

        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ fontWeight: 900 }}>ISBN, Titel oder Autor…</label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doSearch();
                }}
                style={{
                  flex: 1,
                  minWidth: 260,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "inherit",
                }}
                placeholder="z.B. Max Frisch, Der Steppenwolf, 978…"
              />
              <button
                onClick={() => void doSearch()}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                Suchen
              </button>
            </div>
          </div>

          <div style={{ marginTop: 6, opacity: 0.9 }}>{loading ? "Lädt…" : `Treffer (${results.length})`}</div>

          <div style={{ display: "grid", gap: 10 }}>
            {results.map((r) => (
              <div
                key={r.isbn}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                {r.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.coverUrl}
                    alt=""
                    width={50}
                    height={74}
                    style={{ borderRadius: 10, objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 50,
                      height: 74,
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.12)",
                      opacity: 0.6,
                    }}
                  />
                )}

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 900 }}>{r.title}</div>
                  <div style={{ opacity: 0.85 }}>{r.authors}</div>
                  <div style={{ opacity: 0.65, fontSize: 12 }}>ISBN: {r.isbn}</div>
                </div>

                <button
                  onClick={() => void saveBook(r)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "transparent",
                    cursor: "pointer",
                    fontWeight: 900,
                    minWidth: 110,
                    opacity: user ? 1 : 0.7,
                  }}
                  title={user ? "In deine Bibliothek speichern" : "Bitte einloggen"}
                >
                  Speichern
                </button>
              </div>
            ))}
          </div>

          {/* Bulk add */}
          <div
            style={{
              marginTop: 18,
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              display: "grid",
              gap: 10,
              opacity: user ? 1 : 0.85,
            }}
          >
            <div style={{ fontWeight: 900 }}>Bulk-Add (optional)</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Eine Zeile pro Buch (Titel oder ISBN). Speichert automatisch den besten Treffer.
            </div>

            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={6}
              placeholder={`Beispiel:\nDer Schatten des Windes\n9783832165987\nThe Rosie Project`}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: "inherit",
                resize: "vertical",
              }}
            />

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Zeilen: {parseBulkLines(bulkText).length}</div>
              <button
                disabled={bulkWorking}
                onClick={() => void bulkAdd()}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: bulkWorking ? "rgba(255,255,255,0.08)" : "transparent",
                  cursor: bulkWorking ? "default" : "pointer",
                  fontWeight: 900,
                }}
                title={user ? "Bulk speichern" : "Bitte einloggen"}
              >
                {bulkWorking ? "Speichert…" : "Bulk speichern"}
              </button>
            </div>

            {!user && (
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Hinweis: Speichern funktioniert erst nach Login/Registrierung (oben rechts).
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
