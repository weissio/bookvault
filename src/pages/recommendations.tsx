import { useEffect, useMemo, useRef, useState } from "react";

type MeResponse =
  | { ok: true; user: { id: number; email: string } | null }
  | { ok: false; error: string };

type Reason = { label: string; detail?: string };

type RecItem = {
  recId: string;
  workKey: string | null;
  isbn: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  description?: string | null;
  score: number;
  reasons: Reason[];
  subjects: string[];
};

type RecResponse =
  | {
      ok: true;
      profile: {
        likedCount: number;
        topSubjects: { subject: string; weight: number }[];
        topAuthors: { author: string; weight: number }[];
      };
      recommendations: RecItem[];
      meta?: { frozen?: boolean; hasCache?: boolean };
      debug?: any;
    }
  | { ok: false; error: string };

type AddResponse =
  | { ok: true; entry: any }
  | { ok: false; error: string };

type FeedbackResponse =
  | { ok: true; key: string; action: "like" | "dislike" }
  | { ok: false; error: string };

type BlockResponse =
  | { ok: true; id: number }
  | { ok: false; error: string };

type LibrarySeedEntry = {
  id: number;
  title: string;
  authors: string;
  status: string;
  rating: number | null;
};

type LibraryListResponse =
  | { ok: true; entries: LibrarySeedEntry[] }
  | { ok: false; error: string };

function nowId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

type Toast = { id: string; text: string; kind: "success" | "error" | "info" };

function truncate(text: string, max = 340) {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

export default function RecommendationsPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const user = useMemo(() => (me && (me as any).ok ? (me as any).user : null), [me]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const [seedMode, setSeedMode] = useState<"liked" | "allRead">("liked");
  const [minRating, setMinRating] = useState(4);
  const [limit, setLimit] = useState(15);
  const [deOnly, setDeOnly] = useState(false);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);

  const [data, setData] = useState<RecResponse | null>(null);
  const [librarySeeds, setLibrarySeeds] = useState<LibrarySeedEntry[]>([]);
  const [selectedSeedIds, setSelectedSeedIds] = useState<number[]>([]);
  const [seedLoading, setSeedLoading] = useState(false);
  // ✅ saved by recId (not ISBN) so editions/dupes don't cause weird UI behavior
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [preference, setPreference] = useState<Record<string, "like" | "dislike">>({});
  const [prefLoading, setPrefLoading] = useState<Record<string, boolean>>({});
  const [blockLoading, setBlockLoading] = useState<Record<string, boolean>>({});
  const [expandedRecDesc, setExpandedRecDesc] = useState<Record<string, boolean>>({});

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
    const r = await fetch("/api/auth/me");
    const j = (await r.json()) as MeResponse;
    setMe(j);
  }

  const eligibleSeedIds = useMemo(() => {
    return librarySeeds
      .filter((x) => {
        if (x.status !== "read") return false;
        if (seedMode === "allRead") return true;
        return typeof x.rating === "number" && x.rating >= minRating;
      })
      .map((x) => x.id);
  }, [librarySeeds, seedMode, minRating]);

  async function loadSeeds() {
    if (!user) return;
    setSeedLoading(true);
    try {
      const r = await fetch("/api/library/list");
      const j = (await r.json()) as LibraryListResponse;
      if (!j.ok) {
        setMsg(j.error || "Seed-Bibliothek konnte nicht geladen werden.");
        return;
      }
      setLibrarySeeds(j.entries || []);
    } catch (e: any) {
      setMsg(e?.message ?? "Seed-Bibliothek konnte nicht geladen werden.");
    } finally {
      setSeedLoading(false);
    }
  }

  async function load(force = false) {
    setLoading(true);
    setMsg(null);
    setData(null);
    try {
      const params = new URLSearchParams();
      params.set("seedMode", seedMode);
      params.set("minRating", String(minRating));
      params.set("limit", String(limit));
      if (deOnly) params.set("deOnly", "1");
      if (typeFilters.length > 0) params.set("types", typeFilters.join(","));
      if (force) params.set("force", "1");

      const eligibleSet = new Set(eligibleSeedIds);
      const filteredSelected = selectedSeedIds.filter((id) => eligibleSet.has(id));
      if (filteredSelected.length > 0) {
        params.set("seedEntryIds", filteredSelected.join(","));
      }

      const r = await fetch(`/api/recommendations?${params.toString()}`);
      const j = (await r.json()) as RecResponse;
      setData(j);
      if (!j.ok) setMsg(j.error || "Konnte Empfehlungen nicht laden.");
    } catch (e: any) {
      setMsg(e?.message ?? "Unbekannter Fehler");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadSeeds();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, seedMode, minRating, limit, deOnly, typeFilters.join(","), selectedSeedIds.join(","), eligibleSeedIds.join(",")]);

  useEffect(() => {
    const eligibleSet = new Set(eligibleSeedIds);
    setSelectedSeedIds((prev) => prev.filter((id) => eligibleSet.has(id)));
  }, [eligibleSeedIds.join(",")]);

  async function saveToLibrary(item: RecItem) {
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
          source: "recommendation",
          recId: item.recId,
          workKey: item.workKey,
        }),
      });
      const j = (await r.json()) as AddResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Speichern fehlgeschlagen.");
        return;
      }
      setSaved((p) => ({ ...p, [item.recId]: true }));
      pushToast("success", `Gespeichert ✓  ${item.title}`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Speichern fehlgeschlagen.");
    }
  }

  async function sendPreference(item: RecItem, action: "like" | "dislike") {
    if (!user) {
      pushToast("info", "Bitte einloggen, um Präferenzen zu speichern.");
      return;
    }

    setPrefLoading((p) => ({ ...p, [item.recId]: true }));
    try {
      const r = await fetch("/api/recommendation-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recId: item.recId,
          workKey: item.workKey,
          isbn: item.isbn,
          title: item.title,
          authors: item.authors,
          action,
        }),
      });

      const j = (await r.json()) as FeedbackResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Feedback speichern fehlgeschlagen.");
        return;
      }

      setPreference((p) => ({ ...p, [item.recId]: action }));
      if (action === "like") pushToast("success", `Passt zu mir ✓  ${item.title}`);
      if (action === "dislike") pushToast("info", `Eher nicht ✓  ${item.title}`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Feedback speichern fehlgeschlagen.");
    } finally {
      setPrefLoading((p) => ({ ...p, [item.recId]: false }));
    }
  }


  async function blockItem(item: RecItem) {
    if (!user) {
      pushToast("info", "Bitte einloggen, um Bücher auszublenden.");
      return;
    }

    setBlockLoading((p) => ({ ...p, [item.recId]: true }));
    try {
      const r = await fetch("/api/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workKey: item.workKey,
          isbn: item.isbn,
          title: item.title,
          authors: item.authors,
        }),
      });

      const j = (await r.json()) as BlockResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Ausblenden fehlgeschlagen.");
        return;
      }

      // remove from UI immediately
      setData((prev) => {
        if (!prev || !(prev as any).ok) return prev;
        const next = { ...(prev as any) };
        next.recommendations = next.recommendations.filter((x: RecItem) => x.recId !== item.recId);
        return next;
      });

      pushToast("success", `Ausgeblendet ✓  ${item.title}`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Ausblenden fehlgeschlagen.");
    } finally {
      setBlockLoading((p) => ({ ...p, [item.recId]: false }));
    }
  }

  if (me && (me as any).ok && !user) {
    return (
      <div className="app-shell">
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Empfehlungen</h1>
              <p className="page-subtitle">
                Dafür brauchst du einen Account, weil Empfehlungen aus deiner Bibliothek abgeleitet werden.
              </p>
            </div>
            <div className="nav-links">
              <a className="nav-pill" href="/">
                Startseite
              </a>
            </div>
          </header>
        </div>
      </div>
    );
  }

  const okData = data && (data as any).ok ? (data as any) : null;

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
            <h1 className="page-title">Empfehlungen</h1>
            <p className="page-subtitle">Jede Empfehlung zeigt dir transparent, warum sie passt.</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="nav-links">
              <a className="nav-pill primary" href="/library">
                Bibliothek
              </a>
              <a className="nav-pill" href="/blocklist">
                Sperrliste
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

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="toolbar">
            <div className="toolbar-group">
              <div className="filter-field">
                <label>Basis</label>
                <select value={seedMode} onChange={(e) => setSeedMode(e.target.value as any)}>
                  <option value="liked">Gelesen & Bewertung ≥ min</option>
                  <option value="allRead">Alle gelesenen (auch ohne Bewertung)</option>
                </select>
              </div>

              <div className="filter-field">
                <label>min. Bewertung</label>
                <select value={String(minRating)} onChange={(e) => setMinRating(Number(e.target.value))}>
                  <option value="3">3+</option>
                  <option value="4">4+</option>
                  <option value="5">5+</option>
                  <option value="7">7+</option>
                </select>
              </div>

              <div className="filter-field">
                <label>Anzahl</label>
                <select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
                  <option value="15">15</option>
                  <option value="20">20</option>
                </select>
              </div>

              <div className="filter-field">
                <label>Sprache</label>
                <select value={deOnly ? "de_only" : "de_pref"} onChange={(e) => setDeOnly(e.target.value === "de_only")}>
                  <option value="de_pref">Deutsch priorisieren</option>
                  <option value="de_only">Nur deutsch (streng)</option>
                </select>
              </div>
            </div>

            <div className="toolbar-group">
              <button onClick={() => void load(true)} className="btn btn-soft">
                Neu berechnen
              </button>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Literaturtyp</div>
            <div className="chips">
              {[
                { id: "fiction", label: "Roman" },
                { id: "nonfiction", label: "Sachbuch" },
                { id: "selfhelp", label: "Ratgeber" },
                { id: "biography", label: "Biografie" },
                { id: "science", label: "Wissenschaft" },
              ].map((t) => {
                const checked = typeFilters.includes(t.id);
                return (
                  <label key={t.id} className="chip" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setTypeFilters((prev) => {
                          if (on) return Array.from(new Set([...prev, t.id]));
                          return prev.filter((x) => x !== t.id);
                        });
                      }}
                    />
                    <span>{t.label}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 12 }} className="muted">
              Leer lassen = automatische Verteilung nach deiner Bibliothek.
            </div>
          </div>

          <details className="panel" style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 800 }}>
              Wie entsteht der Score? <span className="muted">(V1)</span>
            </summary>
            <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }} className="muted">
              <div style={{ marginBottom: 8 }}>
                <code>Score = Story (60%) + Themen (28%) + Autor (12%)</code>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>Story hat das höchste Gewicht: Erzaehlmotive und Kernthemen aus deinen Seed-Buechern.</li>
                <li>Themen gleichen Subjects aus deiner Bibliothek mit Kandidaten ab.</li>
                <li>Autor bleibt bewusst bei 10-15%, damit nicht nur gleiche Autor:innen erscheinen.</li>
                <li>Dublettenerkennung entfernt gleiche Werke auch ueber Sprachen und Editionen hinweg.</li>
              </ul>
            </div>
          </details>

          <div style={{ fontSize: 12, marginTop: 10 }} className="muted">
            V1-Logik: Story + Subjects aus deiner Bibliothek → Kandidaten → Score + „Warum?“ + Inhaltsangabe.
            {okData ? (
              <span style={{ marginLeft: 8 }}>
                Seeds: <b>{okData.profile?.likedCount ?? 0}</b> • Top-Themen: <b>{okData.profile?.topSubjects?.length ?? 0}</b> • Top-Autor:innen:{" "}
                <b>{okData.profile?.topAuthors?.length ?? 0}</b>
              </span>
            ) : null}
          </div>

          <div style={{ fontSize: 12, marginTop: 6 }} className="muted">
            (Sprache: {deOnly ? "Nur deutsch" : "Deutsch priorisiert"}) • Freeze bis "Neu berechnen"
          </div>

          <details className="panel" style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 800 }}>Seed-Buecher auswaehlen (optional)</summary>
            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              <div style={{ fontSize: 13 }} className="muted">
                Ohne Auswahl nutzt das System automatisch alle passenden Buecher aus deiner Bibliothek.
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setSelectedSeedIds(eligibleSeedIds)} className="btn btn-ghost">
                  Alle waehlen
                </button>
                <button onClick={() => setSelectedSeedIds([])} className="btn btn-ghost">
                  Auswahl leeren
                </button>
                <div style={{ fontSize: 12, alignSelf: "center" }} className="muted">
                  Ausgewaehlt: <b>{selectedSeedIds.length}</b> / {eligibleSeedIds.length}
                </div>
              </div>

              {seedLoading ? (
                <div style={{ fontSize: 13 }} className="muted">
                  Lade Bibliothek...
                </div>
              ) : (
                <div style={{ maxHeight: 220, overflow: "auto", borderRadius: 12, border: "1px solid var(--line)", padding: 10 }}>
                  {librarySeeds
                    .filter((x) => eligibleSeedIds.includes(x.id))
                    .map((entry) => {
                      const checked = selectedSeedIds.includes(entry.id);
                      return (
                        <label key={entry.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: 6, borderRadius: 8 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setSelectedSeedIds((prev) => {
                                if (on) return Array.from(new Set([...prev, entry.id]));
                                return prev.filter((id) => id !== entry.id);
                              });
                            }}
                          />
                          <div style={{ fontSize: 13 }}>
                            <div style={{ fontWeight: 800 }}>{entry.title}</div>
                            <div className="muted">{entry.authors}</div>
                            <div style={{ fontSize: 12 }} className="muted">
                              Bewertung: {typeof entry.rating === "number" ? `${entry.rating}/10` : "-"}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                </div>
              )}
            </div>
          </details>
        </div>

        <div className="section">
          <div className="section-title">
            <span>Empfehlungen</span>
            <span className="section-meta">
              {data && (data as any).ok ? `${(data as any).recommendations.length} Treffer` : "—"} {loading ? "• lädt…" : ""}
            </span>
          </div>

          {data && (data as any).ok && (data as any).recommendations.length === 0 && !loading && (
            <div className="muted">
              {(data as any).meta?.frozen
                ? "Noch keine Berechnung vorhanden. Klicke auf Neu berechnen, um Empfehlungen zu erzeugen."
                : "Noch keine Empfehlungen. Tipp: Markiere gelesene Bücher und gib Bewertungen (z.B. 7–10), damit das Profil stärker wird."}
            </div>
          )}

          <div className="books-grid">
            {data && (data as any).ok
              ? (data as any).recommendations.map((x: RecItem) => (
                  <div key={x.recId} className="book-card">
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {x.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={x.coverUrl} alt="" width={64} height={92} style={{ borderRadius: 12, objectFit: "cover", boxShadow: "0 6px 14px rgba(0,0,0,0.15)" }} />
                      ) : (
                        <div style={{ width: 64, height: 92, borderRadius: 12, border: "1px dashed var(--line)", opacity: 0.6 }} />
                      )}

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 16 }}>{x.title}</div>
                        <div className="muted">{x.authors}</div>
                        <div style={{ opacity: 0.65, fontSize: 12 }}>ISBN: {x.isbn}</div>

                        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.88 }}>
                          <span style={{ fontWeight: 800 }}>Inhalt:</span>{" "}
                          {x.description ? (
                            <>
                              {expandedRecDesc[x.recId] ? x.description : truncate(x.description, 260)}
                              {x.description.length > 260 ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedRecDesc((p) => ({ ...p, [x.recId]: !p[x.recId] }))}
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
                                  {expandedRecDesc[x.recId] ? "Weniger" : "Mehr"}
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <span style={{ opacity: 0.7 }}>nicht verfügbar</span>
                          )}
                        </div>

                        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Warum?</div>
                          <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.9 }}>
                            {x.reasons.slice(0, 3).map((r, idx) => (
                              <li key={idx} style={{ marginBottom: 4 }}>
                                <span style={{ fontWeight: 800 }}>{r.label}:</span> <span style={{ opacity: 0.9 }}>{r.detail || ""}</span>
                              </li>
                            ))}
                          </ul>

                          {x.subjects?.length ? (
                            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                              Themen (Auszug): {truncate(x.subjects.slice(0, 6).join(", "), 140)}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
                        <div style={{ fontSize: 12, opacity: 0.7, fontWeight: 800 }}>Score</div>
                        <div style={{ fontWeight: 900 }}>{x.score.toFixed(1)}</div>

                        <div style={{ display: "grid", gap: 6, width: "100%" }}>
                          <button
                            disabled={!!prefLoading[x.recId]}
                            onClick={() => void sendPreference(x, "like")}
                            className="btn"
                            style={{ background: preference[x.recId] === "like" ? "rgba(76,175,80,0.25)" : undefined, opacity: prefLoading[x.recId] ? 0.7 : 1 }}
                            title="Präferenzsignal vor dem Lesen"
                          >
                            {preference[x.recId] === "like" ? "Passt zu mir ✓" : "Passt zu mir"}
                          </button>

                          <button
                            disabled={!!prefLoading[x.recId]}
                            onClick={() => void sendPreference(x, "dislike")}
                            className="btn"
                            style={{ background: preference[x.recId] === "dislike" ? "rgba(244,67,54,0.24)" : undefined, opacity: prefLoading[x.recId] ? 0.7 : 1 }}
                            title="Präferenzsignal vor dem Lesen"
                          >
                            {preference[x.recId] === "dislike" ? "Eher nicht ✓" : "Eher nicht"}
                          </button>

                          <button
                            disabled={!!saved[x.recId]}
                            onClick={() => void saveToLibrary(x)}
                            className="btn btn-soft"
                            style={{ opacity: saved[x.recId] ? 0.7 : 1 }}
                            title="In deine Bibliothek speichern"
                          >
                            {saved[x.recId] ? "Gespeichert ✓" : "In Bibliothek speichern"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}
