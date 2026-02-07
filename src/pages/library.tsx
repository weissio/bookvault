import { useEffect, useMemo, useRef, useState } from "react";

type MeResponse =
  | { ok: true; user: { id: number; email: string } | null }
  | { ok: false; error: string };

type Entry = {
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
  recommended?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type ListResponse = { ok: true; entries: Entry[] } | { ok: false; error: string };
type UpdateResponse = { ok: true; entry: Entry } | { ok: false; error: string };
type DeleteResponse = { ok: true; deletedId: number } | { ok: false; error: string };

type ImportResponse =
  | { ok: true; imported: number; updated: number; skipped: number; totalInFile: number }
  | { ok: false; error: string };

type Toast = { id: string; text: string; kind: "success" | "error" | "info" };

function nowId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeParseSubjects(raw: string | null): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
  } catch {
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [s];
}

function truncate(text: string, max: number) {
  const t = text ?? "";
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

function statusLabel(s: string) {
  switch (s) {
    case "unread":
      return "Ungelesen";
    case "reading":
      return "In Lektüre";
    case "paused":
      return "Pausiert";
    case "read":
      return "Gelesen";
    default:
      return s;
  }
}

function statusDot(s: string) {
  switch (s) {
    case "unread":
      return "⚪";
    case "reading":
      return "🟦";
    case "paused":
      return "🟨";
    case "read":
      return "🟩";
    default:
      return "⚪";
  }
}

function hasMeaningfulText(t: string | null) {
  return !!(t && String(t).trim().length > 0);
}

function primaryGenre(rawSubjects: string | null) {
  const subs = safeParseSubjects(rawSubjects);
  if (subs.length === 0) return "Ohne Genre";
  return subs[0];
}

export default function LibraryPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const user = useMemo(() => (me && (me as any).ok ? (me as any).user : null), [me]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);

  // Accordion: only one entry expanded at a time
  const [openEntryId, setOpenEntryId] = useState<number | null>(null);

  // Expand states inside details (description + subjects)
  const [expandedDesc, setExpandedDesc] = useState<Record<number, boolean>>({});
  const [expandedSubjects, setExpandedSubjects] = useState<Record<number, boolean>>({});

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterRating, setFilterRating] = useState<string>("all");

  // Import
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimer = useRef<Record<string, any>>({});

  function pushToast(kind: Toast["kind"], text: string, ms = 1800) {
    const id = nowId();
    setToasts((prev) => [{ id, kind, text }, ...prev].slice(0, 3));
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

  async function loadEntries() {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/library/list");
      const j = (await r.json()) as ListResponse;
      if (!j.ok) {
        setMsg(j.error || "Konnte Bibliothek nicht laden.");
        setEntries([]);
        return;
      }
      setEntries(j.entries || []);
    } catch (e: any) {
      setMsg(e?.message ?? "Unbekannter Fehler");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filterStatus !== "all" && e.status !== filterStatus) return false;
      if (filterRating === "rated" && (e.rating == null || e.rating <= 0)) return false;
      if (filterRating === "unrated" && e.rating != null && e.rating > 0) return false;
      return true;
    });
  }, [entries, filterStatus, filterRating]);

  const recommendedEntries = useMemo(() => filtered.filter((e) => !!e.recommended), [filtered]);
  const shelfEntries = useMemo(() => filtered.filter((e) => !e.recommended), [filtered]);

  const groupedShelves = useMemo(() => {
    const groups = new Map<string, Entry[]>();
    for (const entry of shelfEntries) {
      const key = primaryGenre(entry.subjects);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    return Array.from(groups.entries()).sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0], "de");
    });
  }, [shelfEntries]);

  // If current open entry is filtered out or deleted, close it
  useEffect(() => {
    if (openEntryId == null) return;
    const stillVisible = filtered.some((x) => x.id === openEntryId);
    if (!stillVisible) setOpenEntryId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterRating, entries]);

  async function updateEntry(id: number, patch: Partial<Entry>, { quietToast }: { quietToast?: boolean } = {}) {
    setMsg(null);
    try {
      const r = await fetch("/api/library/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // IMPORTANT: send both id + entryId to be compatible with API expecting either
        body: JSON.stringify({ id, entryId: id, ...patch }),
      });
      const j = (await r.json()) as UpdateResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Update fehlgeschlagen.");
        return;
      }
      setEntries((prev) => prev.map((x) => (x.id === id ? j.entry : x)));
      if (!quietToast) pushToast("success", "Gespeichert ✓");
    } catch (e: any) {
      pushToast("error", e?.message ?? "Update fehlgeschlagen.");
    }
  }

  async function deleteEntry(id: number, title: string) {
    const ok = window.confirm(`Wirklich löschen?\n\n${title}`);
    if (!ok) return;

    try {
      const r = await fetch("/api/library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = (await r.json()) as DeleteResponse;
      if (!j.ok) {
        pushToast("error", j.error || "Löschen fehlgeschlagen.");
        return;
      }
      setEntries((prev) => prev.filter((x) => x.id !== id));
      if (openEntryId === id) setOpenEntryId(null);
      pushToast("success", `Gelöscht ✓`);
    } catch (e: any) {
      pushToast("error", e?.message ?? "Löschen fehlgeschlagen.");
    }
  }

  async function exportJson() {
    try {
      const r = await fetch("/api/library/export");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bookvault_export_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast("success", "Export gestartet ✓");
    } catch (e: any) {
      pushToast("error", e?.message ?? "Export fehlgeschlagen.");
    }
  }

  async function importJsonFile(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const payload = { entries: parsed.entries ?? parsed };

      const r = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as ImportResponse;

      if (!j.ok) {
        pushToast("error", j.error || "Import fehlgeschlagen.");
        return;
      }

      pushToast("success", `Import ✓  Neu: ${j.imported}, aktualisiert: ${j.updated}`);
      await loadEntries();
    } catch (e: any) {
      pushToast("error", e?.message ?? "Import fehlgeschlagen.");
    }
  }

  function toggleDetails(id: number) {
    setOpenEntryId((cur) => (cur === id ? null : id));
  }

  const SUBJECTS_COLLAPSE_COUNT = 10;
  const DESC_COLLAPSE_CHARS = 420;

  function renderEntryCard(entry: Entry, { highlight }: { highlight?: boolean } = {}) {
    const detailsOpen = openEntryId === entry.id;
    const detailsId = `entry_details_${entry.id}`;

    const subs = safeParseSubjects(entry.subjects);
    const isSubsExpanded = !!expandedSubjects[entry.id];
    const subsToShow = isSubsExpanded ? subs : subs.slice(0, SUBJECTS_COLLAPSE_COUNT);
    const needsSubsToggle = subs.length > SUBJECTS_COLLAPSE_COUNT;

    const desc = entry.description ? String(entry.description) : "";
    const hasDesc = desc.trim().length > 0;
    const isDescExpanded = !!expandedDesc[entry.id];
    const descToShow = isDescExpanded ? desc : truncate(desc, DESC_COLLAPSE_CHARS);
    const needsDescToggle = hasDesc && desc.length > DESC_COLLAPSE_CHARS;

    const hasNotes = hasMeaningfulText(entry.notes);

    const topGenres = subs.slice(0, 3);
    const moreGenres = subs.length > 3 ? subs.length - 3 : 0;

    return (
      <div key={entry.id} className={`book-card${highlight ? " recommended" : ""}`}>
        <button
          type="button"
          onClick={() => toggleDetails(entry.id)}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          style={{
            width: "100%",
            textAlign: "left",
            border: "none",
            background: "transparent",
            color: "inherit",
            padding: 0,
            cursor: "pointer",
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              toggleDetails(entry.id);
            }
          }}
        >
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            {entry.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={entry.coverUrl}
                alt=""
                width={64}
                height={92}
                style={{ borderRadius: 12, objectFit: "cover", flex: "0 0 auto", boxShadow: "0 6px 14px rgba(0,0,0,0.15)" }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 92,
                  borderRadius: 12,
                  border: "1px dashed var(--line)",
                  opacity: 0.6,
                  flex: "0 0 auto",
                }}
              />
            )}

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ minWidth: 220 }}>
                    <div
                      style={{
                        fontWeight: 800,
                        fontSize: 16,
                        lineHeight: 1.25,
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.title}
                      </span>
                      {highlight && <span className="badge">Empfohlen</span>}
                    </div>

                    <div
                      style={{
                        opacity: 0.85,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.authors}
                    </div>

                    <div className="book-meta-row" style={{ marginTop: 8 }}>
                      <span>
                        {statusDot(entry.status)} {statusLabel(entry.status)}
                      </span>

                      <span style={{ opacity: 0.6 }}>•</span>

                      <span>{entry.rating ? `★ ${entry.rating}/10` : "— bewertet"}</span>

                      {topGenres.length > 0 && (
                        <>
                          <span style={{ opacity: 0.6 }}>•</span>
                          <span>
                            Genres: {topGenres.join(", ")}
                            {moreGenres > 0 ? ` +${moreGenres}` : ""}
                          </span>
                        </>
                      )}

                      {hasDesc && (
                        <>
                          <span style={{ opacity: 0.6 }}>•</span>
                          <span>Inhaltsangabe</span>
                        </>
                      )}

                      {hasNotes && (
                        <>
                          <span style={{ opacity: 0.6 }}>•</span>
                          <span>Notizen</span>
                        </>
                      )}
                    </div>

                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55 }}>ISBN: {entry.isbn}</div>
                  </div>
                </div>

                <div
                  aria-hidden="true"
                  style={{
                    fontWeight: 900,
                    opacity: 0.65,
                    paddingLeft: 10,
                    flex: "0 0 auto",
                    fontSize: 16,
                    lineHeight: 1,
                    marginTop: 2,
                  }}
                >
                  {detailsOpen ? "▾" : "▸"}
                </div>
              </div>
            </div>
          </div>
        </button>

        {detailsOpen && (
          <div id={detailsId} style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.9 }}>Status</div>
                <select
                  value={entry.status}
                  onChange={(ev) => void updateEntry(entry.id, { status: ev.target.value }, { quietToast: true })}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--paper-2)",
                    minWidth: 220,
                  }}
                >
                  <option value="unread">Ungelesen</option>
                  <option value="reading">In Lektüre</option>
                  <option value="paused">Pausiert</option>
                  <option value="read">Gelesen</option>
                </select>
              </div>

              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.9 }}>Bewertung</div>
                <select
                  value={entry.rating == null ? "" : String(entry.rating)}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    void updateEntry(entry.id, { rating: v === "" ? null : Number(v) }, { quietToast: true });
                  }}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--paper-2)",
                    minWidth: 220,
                  }}
                >
                  <option value="">—</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="7">7</option>
                  <option value="8">8</option>
                  <option value="9">9</option>
                  <option value="10">10</option>
                </select>
              </div>

              <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={() => toggleDetails(entry.id)} className="btn btn-ghost" title="Details einklappen">
                  Einklappen
                </button>
              </div>
            </div>

            {subs.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Genre / Themen</div>
                <div className="chips">
                  {subsToShow.map((s, idx) => (
                    <span key={idx} className="chip">
                      {s}
                    </span>
                  ))}

                  {needsSubsToggle && !isSubsExpanded && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setExpandedSubjects((p) => ({ ...p, [entry.id]: true }));
                      }}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "inherit",
                        textDecoration: "underline",
                        cursor: "pointer",
                        fontWeight: 800,
                        opacity: 0.9,
                        padding: 0,
                        fontSize: 12,
                      }}
                    >
                      +{subs.length - SUBJECTS_COLLAPSE_COUNT} mehr
                    </button>
                  )}

                  {needsSubsToggle && isSubsExpanded && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setExpandedSubjects((p) => ({ ...p, [entry.id]: false }));
                      }}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "inherit",
                        textDecoration: "underline",
                        cursor: "pointer",
                        fontWeight: 800,
                        opacity: 0.9,
                        padding: 0,
                        fontSize: 12,
                      }}
                    >
                      Weniger
                    </button>
                  )}
                </div>
              </div>
            )}

            {hasDesc && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Inhaltsangabe</div>
                <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>
                  {descToShow}{" "}
                  {needsDescToggle && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setExpandedDesc((p) => ({ ...p, [entry.id]: !p[entry.id] }));
                      }}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "inherit",
                        textDecoration: "underline",
                        cursor: "pointer",
                        fontWeight: 800,
                        opacity: 0.9,
                        padding: 0,
                      }}
                    >
                      {isDescExpanded ? "Weniger" : "Mehr anzeigen"}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Notizen</div>
              <textarea
                defaultValue={entry.notes ?? ""}
                placeholder="Eigene Gedanken, Zitate, warum du’s lesen willst…"
                rows={3}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--paper-2)",
                  resize: "vertical",
                }}
                onBlur={(ev) => {
                  const next = ev.currentTarget.value;
                  if ((entry.notes ?? "") === next) return;
                  void updateEntry(entry.id, { notes: next });
                }}
              />
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Speichert beim Verlassen des Feldes.</div>
            </div>

            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  void deleteEntry(entry.id, entry.title);
                }}
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: "6px 10px", opacity: 0.75 }}
                title="Eintrag löschen"
              >
                Löschen
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (me && (me as any).ok && !user) {
    return (
      <div className="app-shell">
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Deine Bibliothek</h1>
              <p className="page-subtitle">Bitte einloggen, um deine Bibliothek zu sehen.</p>
            </div>
            <div className="nav-links">
              <a className="nav-pill" href="/">
                Zur Startseite
              </a>
            </div>
          </header>

          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">Login erforderlich</div>
            <div style={{ marginTop: 6 }} className="muted">
              Deine persönliche Bibliothek ist geschützt. Bitte melde dich an.
            </div>
          </div>
        </div>
      </div>
    );
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
            <h1 className="page-title">Deine Bibliothek</h1>
            <p className="page-subtitle">Dein Wohnzimmer für Bücher, Notizen und Bewertungen.</p>
          </div>

          <div style={{ textAlign: "right" }}>
            <div className="nav-links">
              <a className="nav-pill" href="/">
                Suche
              </a>
              <a className="nav-pill primary" href="/recommendations">
                Empfehlungen
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

        <div className="panel">
          <div className="toolbar">
            <div className="toolbar-group">
              <div className="panel-title">Deine Einträge</div>
              <div className="muted">({filtered.length})</div>

              <div className="filter-field">
                <label>Status</label>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                  <option value="all">Alle</option>
                  <option value="unread">Ungelesen</option>
                  <option value="reading">In Lektüre</option>
                  <option value="paused">Pausiert</option>
                  <option value="read">Gelesen</option>
                </select>
              </div>

              <div className="filter-field">
                <label>Bewertung</label>
                <select value={filterRating} onChange={(e) => setFilterRating(e.target.value)}>
                  <option value="all">Alle</option>
                  <option value="rated">Nur bewertet</option>
                  <option value="unrated">Nur unbewertet</option>
                </select>
              </div>
            </div>

            <div className="toolbar-group">
              <button type="button" onClick={() => void exportJson()} className="btn btn-soft">
                Export (JSON)
              </button>

              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importJsonFile(f);
                  e.currentTarget.value = "";
                }}
              />

              <button type="button" onClick={() => fileRef.current?.click()} className="btn">
                Import (JSON)
              </button>

              <button type="button" onClick={() => void loadEntries()} className="btn btn-ghost" title="Neu laden">
                Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="section">
          {loading ? (
            <div className="muted">Lädt…</div>
          ) : filtered.length === 0 ? (
            <div className="muted">Noch keine Einträge.</div>
          ) : (
            <>
              {recommendedEntries.length > 0 && (
                <div className="section">
                  <div className="section-title">
                    <span>Empfohlen und noch ungelesen</span>
                    <span className="section-meta">{recommendedEntries.length} Bücher</span>
                  </div>
                  <div className="books-grid">
                    {recommendedEntries.map((entry) => renderEntryCard(entry, { highlight: true }))}
                  </div>
                </div>
              )}

              {groupedShelves.map(([genre, items]) => (
                <div key={genre} className="section">
                  <div className="section-title">
                    <span>{genre}</span>
                    <span className="section-meta">{items.length} Bücher</span>
                  </div>
                  <div className="books-grid">{items.map((entry) => renderEntryCard(entry))}</div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="footer-links">
          Empfehlungen:{" "}
          <a href="/recommendations" style={{ textDecoration: "underline" }}>
            /recommendations
          </a>
        </div>
      </div>
    </div>
  );
}
