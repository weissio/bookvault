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
      debug?: any;
    }
  | { ok: false; error: string };

type AddResponse =
  | { ok: true; entry: any }
  | { ok: false; error: string };

type FeedbackResponse =
  | { ok: true; key: string; action: "like" | "dislike" }
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

  const [data, setData] = useState<RecResponse | null>(null);
  const [librarySeeds, setLibrarySeeds] = useState<LibrarySeedEntry[]>([]);
  const [selectedSeedIds, setSelectedSeedIds] = useState<number[]>([]);
  const [seedLoading, setSeedLoading] = useState(false);
  // ✅ saved by recId (not ISBN) so editions/dupes don't cause weird UI behavior
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [preference, setPreference] = useState<Record<string, "like" | "dislike">>({});
  const [prefLoading, setPrefLoading] = useState<Record<string, boolean>>({});

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

  async function load() {
    setLoading(true);
    setMsg(null);
    setData(null);
    try {
      const params = new URLSearchParams();
      params.set("seedMode", seedMode);
      params.set("minRating", String(minRating));
      params.set("limit", String(limit));
      if (deOnly) params.set("deOnly", "1");

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
  }, [user, seedMode, minRating, limit, deOnly, selectedSeedIds.join(","), eligibleSeedIds.join(",")]);

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

  if (me && (me as any).ok && !user) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 980 }}>
          <h1 style={{ fontSize: 28, marginBottom: 6 }}>Empfehlungen</h1>
          <p style={{ opacity: 0.85, marginTop: 0 }}>
            Dafür brauchst du einen Account, weil Empfehlungen aus <b>deiner</b> Bibliothek abgeleitet werden.
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

  const okData = data && (data as any).ok ? (data as any) : null;

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
            <span style={{ opacity: 0.85 }}>
              {t.kind === "success" ? "✅ " : t.kind === "error" ? "⚠️ " : "ℹ️ "}
            </span>
            {t.text}
          </div>
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 1050 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 28, marginBottom: 6 }}>Empfehlungen</h1>
            <p style={{ marginTop: 0, opacity: 0.85 }}>
              Transparent: Jede Empfehlung zeigt dir <b>Warum</b> sie vorgeschlagen wird.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <a href="/library" style={{ textDecoration: "underline" }}>
              → Deine Bibliothek
            </a>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>{user ? user.email : ""}</div>
          </div>
        </div>

        {msg && <div style={{ marginTop: 10, opacity: 0.9 }}>{msg}</div>}

        {/* Controls */}
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 900 }}>Basis</label>
              <select
                value={seedMode}
                onChange={(e) => setSeedMode(e.target.value as any)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "inherit",
                  minWidth: 260,
                }}
              >
                <option value="liked">Gelesen & Bewertung ≥ min</option>
                <option value="allRead">Alle gelesenen (auch ohne Bewertung)</option>
              </select>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 900 }}>min. Bewertung</label>
              <select
                value={String(minRating)}
                onChange={(e) => setMinRating(Number(e.target.value))}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "inherit",
                  minWidth: 160,
                }}
              >
                <option value="3">3+</option>
                <option value="4">4+</option>
                <option value="5">5+</option>
                <option value="7">7+</option>
              </select>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 900 }}>Anzahl</label>
              <select
                value={String(limit)}
                onChange={(e) => setLimit(Number(e.target.value))}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "inherit",
                  minWidth: 160,
                }}
              >
                <option value="15">15</option>
                <option value="20">20</option>
              </select>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 900 }}>Sprache</label>
              <select
                value={deOnly ? "de_only" : "de_pref"}
                onChange={(e) => setDeOnly(e.target.value === "de_only")}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "inherit",
                  minWidth: 220,
                }}
              >
                <option value="de_pref">Deutsch priorisieren</option>
                <option value="de_only">Nur deutsch (streng)</option>
              </select>
            </div>

            <button
              onClick={() => void load()}
              style={{
                marginLeft: "auto",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Neu berechnen
            </button>
          </div>

          <details
            style={{
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.95 }}>
              Wie entsteht der Score?
              <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7, fontWeight: 800 }}>(V1)</span>
            </summary>

            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.92, lineHeight: 1.5 }}>
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

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            V1-Logik: Story + Subjects aus deiner Bibliothek → Kandidaten von OpenLibrary → Score + „Warum?“ + Inhaltsangabe.
            {okData ? (
              <span style={{ marginLeft: 8 }}>
                Seeds: <b>{okData.profile?.likedCount ?? 0}</b> • Top-Themen:{" "}
                <b>{okData.profile?.topSubjects?.length ?? 0}</b> • Top-Autor:innen:{" "}
                <b>{okData.profile?.topAuthors?.length ?? 0}</b>
              </span>
            ) : null}
          </div>

          <div style={{ fontSize: 12, opacity: 0.72 }}>(Sprache: {deOnly ? "Nur deutsch" : "Deutsch priorisiert"})</div>

          <details
            style={{
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.95 }}>
              Seed-Buecher auswaehlen (optional)
            </summary>

            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              <div style={{ fontSize: 13, opacity: 0.86 }}>
                Ohne Auswahl nutzt das System automatisch alle passenden Buecher aus deiner Bibliothek.
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setSelectedSeedIds(eligibleSeedIds)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "transparent",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  Alle waehlen
                </button>
                <button
                  onClick={() => setSelectedSeedIds([])}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "transparent",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  Auswahl leeren
                </button>
                <div style={{ fontSize: 12, opacity: 0.75, alignSelf: "center" }}>
                  Ausgewaehlt: <b>{selectedSeedIds.length}</b> / {eligibleSeedIds.length}
                </div>
              </div>

              {seedLoading ? (
                <div style={{ fontSize: 13, opacity: 0.75 }}>Lade Bibliothek...</div>
              ) : (
                <div
                  style={{
                    maxHeight: 220,
                    overflow: "auto",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.1)",
                    padding: 8,
                    display: "grid",
                    gap: 6,
                  }}
                >
                  {librarySeeds
                    .filter((x) => eligibleSeedIds.includes(x.id))
                    .map((entry) => {
                      const checked = selectedSeedIds.includes(entry.id);
                      return (
                        <label
                          key={entry.id}
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "flex-start",
                            padding: 6,
                            borderRadius: 8,
                            background: checked ? "rgba(255,255,255,0.05)" : "transparent",
                            cursor: "pointer",
                          }}
                        >
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
                            <div style={{ opacity: 0.78 }}>{entry.authors}</div>
                            <div style={{ opacity: 0.65, fontSize: 12 }}>
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

        {/* Results */}
        <div style={{ marginTop: 16, fontWeight: 900 }}>
          Empfehlungen{" "}
          {data && (data as any).ok ? <span style={{ opacity: 0.7 }}>({(data as any).recommendations.length})</span> : null}
          {loading ? <span style={{ opacity: 0.7, marginLeft: 10 }}>(lädt…)</span> : null}
        </div>

        {data && (data as any).ok && (data as any).recommendations.length === 0 && !loading && (
          <div style={{ marginTop: 10, opacity: 0.8 }}>
            Noch keine Empfehlungen. Tipp: Markiere gelesene Bücher und gib Bewertungen (z.B. 7–10), damit das Profil stärker wird.
          </div>
        )}

        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {data && (data as any).ok
            ? (data as any).recommendations.map((x: RecItem) => (
                <div
                  key={x.recId}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.12)",
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                  }}
                >
                  {x.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={x.coverUrl} alt="" width={58} height={86} style={{ borderRadius: 10, objectFit: "cover" }} />
                  ) : (
                    <div
                      style={{
                        width: 58,
                        height: 86,
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        opacity: 0.6,
                      }}
                    />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>{x.title}</div>
                    <div style={{ opacity: 0.85 }}>{x.authors}</div>
                    <div style={{ opacity: 0.65, fontSize: 12 }}>
                      ISBN: {x.isbn}
                      
                    </div>

                    <div style={{ marginTop: 6, fontSize: 13, opacity: 0.88 }}>
                      <span style={{ fontWeight: 800 }}>Kurzinhalt:</span>{" "}
                      {x.description ? truncate(x.description, 520) : <span style={{ opacity: 0.7 }}>nicht verfügbar</span>}
                    </div>

                    <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                      <div style={{ fontWeight: 900, fontSize: 13 }}>Warum?</div>
                      <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.9 }}>
                        {x.reasons.slice(0, 3).map((r, idx) => (
                          <li key={idx} style={{ marginBottom: 4 }}>
                            <span style={{ fontWeight: 800 }}>{r.label}:</span>{" "}
                            <span style={{ opacity: 0.9 }}>{r.detail || ""}</span>
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
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: preference[x.recId] === "like" ? "rgba(76,175,80,0.25)" : "transparent",
                          cursor: prefLoading[x.recId] ? "default" : "pointer",
                          fontWeight: 900,
                          opacity: prefLoading[x.recId] ? 0.7 : 1,
                          minWidth: 170,
                        }}
                        title="Präferenzsignal vor dem Lesen"
                      >
                        {preference[x.recId] === "like" ? "Passt zu mir ✓" : "Passt zu mir"}
                      </button>

                      <button
                        disabled={!!prefLoading[x.recId]}
                        onClick={() => void sendPreference(x, "dislike")}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: preference[x.recId] === "dislike" ? "rgba(244,67,54,0.24)" : "transparent",
                          cursor: prefLoading[x.recId] ? "default" : "pointer",
                          fontWeight: 900,
                          opacity: prefLoading[x.recId] ? 0.7 : 1,
                          minWidth: 170,
                        }}
                        title="Präferenzsignal vor dem Lesen"
                      >
                        {preference[x.recId] === "dislike" ? "Eher nicht ✓" : "Eher nicht"}
                      </button>

                      <button
                        disabled={!!saved[x.recId]}
                        onClick={() => void saveToLibrary(x)}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: saved[x.recId] ? "rgba(255,255,255,0.08)" : "transparent",
                          cursor: saved[x.recId] ? "default" : "pointer",
                          fontWeight: 900,
                          opacity: saved[x.recId] ? 0.7 : 1,
                          minWidth: 170,
                        }}
                        title="In deine Bibliothek speichern"
                      >
                        {saved[x.recId] ? "Gespeichert ✓" : "In Bibliothek speichern"}
                      </button>
                    </div>
                  </div>
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
