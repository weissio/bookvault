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

  if (me && (me as any).ok && !user) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 980 }}>
          <h1 style={{ fontSize: 28, marginBottom: 6 }}>Deine Bibliothek</h1>
          <p style={{ opacity: 0.85, marginTop: 0 }}>Bitte einloggen, um deine Bibliothek zu sehen.</p>
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

      <div style={{ width: "100%", maxWidth: 1050 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 28, marginBottom: 6 }}>Deine Bibliothek</h1>
            <p style={{ marginTop: 0, opacity: 0.85 }}>Übersicht zuerst – Details nur bei Bedarf.</p>
          </div>

          <div style={{ textAlign: "right" }}>
            <a href="/" style={{ textDecoration: "underline" }}>
              ← Zur Suche
            </a>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>{user ? user.email : ""}</div>
          </div>
        </div>

        {msg && <div style={{ marginTop: 10, opacity: 0.9 }}>{msg}</div>}

        {/* Top bar */}
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>Deine Einträge</div>
            <div style={{ opacity: 0.75 }}>({filtered.length})</div>

            <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)" }} />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 900 }}>Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "transparent",
                    color: "inherit",
                    minWidth: 180,
                  }}
                >
                  <option value="all">Alle</option>
                  <option value="unread">Ungelesen</option>
                  <option value="reading">In Lektüre</option>
                  <option value="paused">Pausiert</option>
                  <option value="read">Gelesen</option>
                </select>
              </div>

              <div style={{ display: "grid", gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 900 }}>Bewertung</label>
                <select
                  value={filterRating}
                  onChange={(e) => setFilterRating(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "transparent",
                    color: "inherit",
                    minWidth: 180,
                  }}
                >
                  <option value="all">Alle</option>
                  <option value="rated">Nur bewertet</option>
                  <option value="unrated">Nur unbewertet</option>
                </select>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => void exportJson()}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
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

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Import (JSON)
            </button>

            <button
              type="button"
              onClick={() => void loadEntries()}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                cursor: "pointer",
                fontWeight: 900,
                opacity: 0.9,
              }}
              title="Neu laden"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Entries */}
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          {loading ? (
            <div style={{ opacity: 0.8 }}>Lädt…</div>
          ) : filtered.length === 0 ? (
            <div style={{ opacity: 0.8 }}>Noch keine Einträge.</div>
          ) : (
            filtered.map((e) => {
              const detailsOpen = openEntryId === e.id;
              const detailsId = `entry_details_${e.id}`;

              const subs = safeParseSubjects(e.subjects);
              const isSubsExpanded = !!expandedSubjects[e.id];
              const subsToShow = isSubsExpanded ? subs : subs.slice(0, SUBJECTS_COLLAPSE_COUNT);
              const needsSubsToggle = subs.length > SUBJECTS_COLLAPSE_COUNT;

              const desc = e.description ? String(e.description) : "";
              const hasDesc = desc.trim().length > 0;
              const isDescExpanded = !!expandedDesc[e.id];
              const descToShow = isDescExpanded ? desc : truncate(desc, DESC_COLLAPSE_CHARS);
              const needsDescToggle = hasDesc && desc.length > DESC_COLLAPSE_CHARS;

              const hasNotes = hasMeaningfulText(e.notes);

              const topGenres = subs.slice(0, 3);
              const moreGenres = subs.length > 3 ? subs.length - 3 : 0;

              return (
                <div
                  key={e.id}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleDetails(e.id)}
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
                        toggleDetails(e.id);
                      }
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {e.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={e.coverUrl}
                          alt=""
                          width={58}
                          height={86}
                          style={{ borderRadius: 10, objectFit: "cover", flex: "0 0 auto" }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 58,
                            height: 86,
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.12)",
                            opacity: 0.6,
                            flex: "0 0 auto",
                          }}
                        />
                      )}

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ minWidth: 220 }}>
                              <div
                                style={{
                                  fontWeight: 900,
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
                                  {e.title}
                                </span>
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
                                {e.authors}
                              </div>

                              <div
                                style={{
                                  marginTop: 8,
                                  fontSize: 12,
                                  opacity: 0.78,
                                  display: "flex",
                                  gap: 10,
                                  flexWrap: "wrap",
                                }}
                              >
                                <span>
                                  {statusDot(e.status)} {statusLabel(e.status)}
                                </span>

                                <span style={{ opacity: 0.6 }}>•</span>

                                <span>{e.rating ? `★ ${e.rating}/10` : "— bewertet"}</span>

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

                              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55 }}>ISBN: {e.isbn}</div>
                            </div>
                          </div>

                          <div
                            aria-hidden="true"
                            style={{
                              fontWeight: 900,
                              opacity: 0.75,
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
                          <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.9 }}>Status</div>
                          <select
                            value={e.status}
                            onChange={(ev) => void updateEntry(e.id, { status: ev.target.value }, { quietToast: true })}
                            style={{
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: "1px solid rgba(255,255,255,0.18)",
                              background: "transparent",
                              color: "inherit",
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
                          <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.9 }}>Bewertung</div>
                          <select
                            value={e.rating == null ? "" : String(e.rating)}
                            onChange={(ev) => {
                              const v = ev.target.value;
                              void updateEntry(e.id, { rating: v === "" ? null : Number(v) }, { quietToast: true });
                            }}
                            style={{
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: "1px solid rgba(255,255,255,0.18)",
                              background: "transparent",
                              color: "inherit",
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
                          <button
                            type="button"
                            onClick={() => toggleDetails(e.id)}
                            style={{
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: "1px solid rgba(255,255,255,0.18)",
                              background: "transparent",
                              cursor: "pointer",
                              fontWeight: 900,
                              opacity: 0.9,
                            }}
                            title="Details einklappen"
                          >
                            Einklappen
                          </button>
                        </div>
                      </div>

                      {subs.length > 0 && (
                        <div style={{ marginTop: 14 }}>
                          <div style={{ fontWeight: 900, marginBottom: 8 }}>Genre / Themen</div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                            {subsToShow.map((s, idx) => (
                              <span
                                key={idx}
                                style={{
                                  fontSize: 12,
                                  padding: "4px 8px",
                                  borderRadius: 999,
                                  border: "1px solid rgba(255,255,255,0.14)",
                                  opacity: 0.95,
                                }}
                              >
                                {s}
                              </span>
                            ))}

                            {needsSubsToggle && !isSubsExpanded && (
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  setExpandedSubjects((p) => ({ ...p, [e.id]: true }));
                                }}
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: "inherit",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                  fontWeight: 900,
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
                                  setExpandedSubjects((p) => ({ ...p, [e.id]: false }));
                                }}
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: "inherit",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                  fontWeight: 900,
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
                          <div style={{ fontWeight: 900, marginBottom: 8 }}>Inhaltsangabe</div>
                          <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>
                            {descToShow}{" "}
                            {needsDescToggle && (
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  setExpandedDesc((p) => ({ ...p, [e.id]: !p[e.id] }));
                                }}
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: "inherit",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                  fontWeight: 900,
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
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Notizen</div>
                        <textarea
                          defaultValue={e.notes ?? ""}
                          placeholder="Eigene Gedanken, Zitate, warum du’s lesen willst…"
                          rows={3}
                          style={{
                            width: "100%",
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "transparent",
                            color: "inherit",
                            resize: "vertical",
                          }}
                          onBlur={(ev) => {
                            const next = ev.currentTarget.value;
                            if ((e.notes ?? "") === next) return;
                            void updateEntry(e.id, { notes: next });
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
                            void deleteEntry(e.id, e.title);
                          }}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.14)",
                            background: "transparent",
                            cursor: "pointer",
                            fontWeight: 900,
                            opacity: 0.75,
                            fontSize: 12,
                          }}
                          title="Eintrag löschen"
                        >
                          Löschen
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div style={{ marginTop: 18, fontSize: 12, opacity: 0.75 }}>
          Empfehlungen:{" "}
          <a href="/recommendations" style={{ textDecoration: "underline" }}>
            /recommendations
          </a>
        </div>
      </div>
    </div>
  );
}
