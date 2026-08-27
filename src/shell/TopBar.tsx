import { useEffect, useRef, useState } from "react";
import type { Inspector, WorkspaceTab } from "../app/types";
import type { WorkspaceView } from "../types";

function relativeAge(timestamp: string, now: number): string {
  const ageMs = Math.max(0, now - Date.parse(timestamp));
  if (ageMs < 60_000) return "<1 min ago";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} min ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

export function TopBar({
  state,
  title = state.active.config.name,
  destination = "feed",
  onMind,
  onFeed,
  onInspector,
  onWorkspace,
}: {
  state: WorkspaceView;
  title?: string;
  destination?: "feed" | "mind";
  onMind?: () => void;
  onFeed: (id: string) => void;
  onInspector?: (value: Inspector) => void;
  onWorkspace?: (tab?: WorkspaceTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const queueRunner = state.queueRunner;
  const queueCheckAge = queueRunner ? relativeAge(queueRunner.lastCheckedAt, now) : null;
  const queueCheckLabel = queueRunner?.state === "processing"
    ? "Queue processing now"
    : queueRunner?.state === "error"
      ? `Queue check failed · ${queueCheckAge}`
      : queueRunner?.state === "inactive"
        ? "Queue inactive"
        : queueRunner?.state === "processed"
          ? `Queue checked ${queueCheckAge} · Work processed`
          : `Queue checked ${queueCheckAge} · Empty`;
  const lastProcessedTime = queueRunner?.lastProcessedAt
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(queueRunner.lastProcessedAt))
    : null;
  const workspaceLinks = (state.links ?? []).map((link) => ({
    ...link,
    href: link.href.startsWith("/review-artifacts/") && typeof window !== "undefined"
      ? `${link.href}?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`
      : link.href,
  }));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div className="feed-bar" ref={menuRef}>
      <button className="menu-trigger" onClick={() => setOpen(!open)} aria-label="Open feed navigation">☰</button>
      <strong>{title}</strong>
      {queueRunner && (
        <span className={`tend-status-chip tend-status-${queueRunner.state}`} title={`Queue last checked at ${queueRunner.lastCheckedAt}`}>
          {queueCheckLabel}
        </span>
      )}
      {lastProcessedTime && (
        <span className={`tend-status-chip tend-status-secondary tend-status-${queueRunner?.lastProcessedStatus ?? "succeeded"}`} title={`Work last processed at ${queueRunner?.lastProcessedAt}`}>
          Last work · {lastProcessedTime}
        </span>
      )}
      {workspaceLinks.length > 0 && <nav className="workspace-links" aria-label="Workspace links">
        {workspaceLinks.map((link) => <a key={link.id} className="workspace-link" href={link.href}>{link.label}</a>)}
      </nav>}
      {open && (
        <div className="feed-menu">
          {onMind && <>
            <button className={destination === "mind" ? "selected" : ""} onClick={() => { onMind(); setOpen(false); }}>
              <span>On Your Mind</span><small>Current signals and their source observations</small>
            </button>
            <div className="menu-rule" />
          </>}
          <div className="menu-title">Feeds</div>
          {state.feeds.map((feed) => (
            <button key={feed.id} className={destination === "feed" && feed.id === state.active.config.id ? "selected" : ""} onClick={() => { onFeed(feed.id); setOpen(false); }}>
              <span>{feed.name}</span><small>{feed.purpose}</small>
            </button>
          ))}
          {onInspector && onWorkspace && <>
            <div className="menu-rule" />
            <button onClick={() => { onInspector("new-feed"); setOpen(false); }}>＋ Create a feed</button>
            <button onClick={() => { onInspector("add-source"); setOpen(false); }}>＋ Add a source</button>
            <button onClick={() => { onWorkspace("feed"); setOpen(false); }}>⌘ Feed setup</button>
            <button onClick={() => { onWorkspace("global"); setOpen(false); }}>⌘ Global prompts</button>
          </>}
        </div>
      )}
    </div>
  );
}
