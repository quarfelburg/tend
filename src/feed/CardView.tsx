import { useEffect, useState, type ReactNode } from "react";
import { containsFullEmail } from "../../shared/emailThread";
import { post } from "../app/api";
import type { Card, CardAction, CardBlock, HeartbeatCardDispositionKind, WorkItemView } from "../types";
import { DetachedLink } from "../ui/DetachedLink";
import { FormattedText } from "../ui/FormattedText";
import { visibleCardActions } from "./selectors";

type ReadableHistoryEntry = { at: string; label: string; detail: string; tone?: "attention" };

function reviewArtifactLinks(card: Card): Array<{ label: string; href: string }> {
  return card.blocks.flatMap((block) => block.type === "evidence"
    ? (block.items ?? []).flatMap((item) => typeof item !== "string" && item.href && /html review/i.test(item.label)
      ? [{ label: item.label, href: item.href }]
      : [])
    : []);
}

function readableHistory(card: Card): ReadableHistoryEntry[] {
  return card.history.flatMap((entry) => {
    if (entry.type === "user.scoped_instruction" || entry.type === "user.instruction") {
      return [{ at: entry.at, label: "You asked", detail: entry.detail ?? "Handle this card." }];
    }
    if (entry.type === "user.approved_action") {
      return [{ at: entry.at, label: "You approved", detail: "The previous next step." }];
    }
    if (entry.type === "user.default_cleanup_approved") {
      return [{ at: entry.at, label: "You approved", detail: "Archive this thread." }];
    }
    if (entry.type === "user.default_cleanup_undone") {
      return [{ at: entry.at, label: "You undid", detail: "The archive instruction." }];
    }
    if (entry.type === "user.edited_artifact") {
      return [{ at: entry.at, label: "You edited", detail: "The proposed artifact." }];
    }
    if (entry.type === "user.cancelled_queued_work") {
      return [{ at: entry.at, label: "You cancelled", detail: "The queued instruction." }];
    }
    if (entry.type === "user.edited_queued_instruction") {
      return [{ at: entry.at, label: "You corrected", detail: entry.detail ?? "The queued note." }];
    }
    if (entry.type === "user.card_dismissed") {
      return [{ at: entry.at, label: "You dismissed", detail: "Removed this card from review. The source was not changed." }];
    }
    if (entry.type === "user.card_finished") {
      return [{ at: entry.at, label: "You marked finished", detail: "This loose end will stay out of future heartbeat reviews." }];
    }
    if (entry.type === "user.card_closed") {
      return [{ at: entry.at, label: "You closed", detail: "This is no longer relevant and will stay out of future heartbeat reviews." }];
    }
    if (entry.type === "user.card_parked") {
      return [{ at: entry.at, label: "You parked", detail: `Do not surface this loose end before ${entry.detail ?? "the chosen date"}.` }];
    }
    if (entry.type === "user.returned_to_review") {
      return [{ at: entry.at, label: "Back for review", detail: "You moved this card back into the sweep." }];
    }
    if (entry.type === "codex.completed") {
      return [{ at: entry.at, label: "Codex did", detail: entry.detail ?? "Finished the requested work." }];
    }
    if (entry.type === "codex.stale_approval") {
      return [{ at: entry.at, label: "Needs review", detail: "The previous approval expired because the card changed. Review the current next step.", tone: "attention" as const }];
    }
    if (entry.type === "codex.failed") {
      return [{ at: entry.at, label: "Codex could not finish", detail: entry.detail ?? "The attempted work needs another look.", tone: "attention" as const }];
    }
    if (entry.type === "codex.approved_action_blocked") {
      return [{ at: entry.at, label: "Still approved", detail: entry.detail ?? "Codex needs to retry the approved action.", tone: "attention" as const }];
    }
    if (entry.type === "codex.approved_action_retry_queued") {
      return [{ at: entry.at, label: "Codex retrying", detail: "Your existing approval is still bound to the unchanged artifact." }];
    }
    if (entry.type === "codex.approved_action_reconciled") {
      return [{ at: entry.at, label: "Codex did", detail: entry.detail ?? "Recorded the approved action as completed after the connector succeeded." }];
    }
    if (entry.type === "routine_action.completed") {
      return [{ at: entry.at, label: "Codex did", detail: "Completed the approved routine cleanup." }];
    }
    return [];
  });
}

function sentenceSummary(text: string, maxSentences = 2): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "No detail was recorded.";
  const beforeNumberedList = normalized.match(/^(.{24,220}?):\s+1\.\s/);
  const recommendation = normalized.match(/\bRecommendation:\s*(.+?)(?=\s+(?:Hayden choice|required|No canonical|No shared|$))/i)?.[1];
  if (beforeNumberedList) {
    const lead = `${beforeNumberedList[1].replace(/[.:;]+$/, "")}.`;
    return recommendation ? `${lead} Recommendation: ${recommendation.replace(/[.!?]*$/, ".")}` : lead;
  }
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [normalized];
  const summary = sentences.slice(0, maxSentences).join(" ");
  if (summary.length <= 320) return summary;
  const shortened = summary.slice(0, 317).replace(/\s+\S*$/, "").trim();
  return `${shortened}…`;
}

function formattedHistoryDetail(text: string): string {
  return text
    .replace(/\s+(?=\d+\.\s+[^.!?]{2,100}\s+(?:Fact|Decision):)/g, "\n\n")
    .replace(/\s+(?=(?:Recommendation|Hayden choice required|No canonical files were changed|No shared source files were changed):?)/g, "\n\n")
    .replace(/\s+(?=(?:Fact|Decision|Owner|Action|Result check|Learning rule|Stop condition):)/g, "\n")
    .trim();
}

function historyTimestamp(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
    timeZoneName: "short",
  }).format(parsed);
}

function CardHistory({ card }: { card: Card }) {
  const [expanded, setExpanded] = useState(false);
  const entries = readableHistory(card);
  if (!entries.length) return null;
  const visible = expanded ? entries : entries.slice(-2);
  const artifactLinks = reviewArtifactLinks(card);
  const latestCodexAt = [...entries].reverse().find((entry) => entry.label === "Codex did")?.at;
  return (
    <section className={`card-history ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <button
        aria-expanded={expanded}
        className="history-toggle"
        onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
        type="button"
      >
        <span className="action-label">History</span>
        <span>{expanded ? "Collapse full history" : `Expand full history${entries.length > 1 ? ` · ${entries.length} updates` : ""}`}</span>
      </button>
      <ol aria-label={expanded ? "Full card history" : "Card history summary"}>
        {visible.map((entry, index) => (
          <li className={entry.tone === "attention" ? "needs-attention" : ""} key={`${entry.at}-${index}`}>
            <div className="history-event-meta">
              <b>{entry.label}</b>
              <time dateTime={entry.at}>{historyTimestamp(entry.at)}</time>
            </div>
            <div className={`history-detail ${expanded ? "history-detail-full" : "history-detail-summary"}`}>
              <FormattedText text={expanded ? formattedHistoryDetail(entry.detail) : sentenceSummary(entry.detail)} />
              {entry.at === latestCodexAt && artifactLinks.length > 0 && (
                <div className="history-artifact-links">
                  {artifactLinks.map((link) => <DetachedLink href={link.href} key={link.href}>{link.label}</DetachedLink>)}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function normalizedBlockLabel(block: CardBlock): string {
  return [block.label, block.summary, block.title].filter(Boolean).join(" ").trim().toLowerCase();
}

function isRecommendedTaskBlock(block: CardBlock): boolean {
  const label = normalizedBlockLabel(block);
  return label.includes("exact codex task") || label.includes("recommended codex task");
}

function displayBlock(block: CardBlock): CardBlock {
  if (!isRecommendedTaskBlock(block)) return block;
  return {
    ...block,
    label: block.label?.replace(/exact codex task/i, "Recommended Codex task") ?? "Recommended Codex task",
    summary: (block.summary ?? block.label ?? "Recommended Codex task").replace(/exact codex task/i, "Recommended Codex task"),
    collapsible: true,
    defaultOpen: true,
  };
}

function blockOrder(block: CardBlock): number {
  const label = normalizedBlockLabel(block);
  if (label === "objective and key results" || block.id === "okr-context" || label === "project" || block.id === "project-context") return 5;
  if (label === "next" || label.startsWith("next ")) return 10;
  if (label.includes("1-3-1")) return 20;
  if (isRecommendedTaskBlock(block)) return 30;
  if (label === "risks" || label.startsWith("risk")) return 40;
  if (label === "sources" || label.startsWith("source") || block.type === "evidence") return 60;
  return 50;
}

function orderedCardBlocks(blocks: CardBlock[]): CardBlock[] {
  return blocks
    .map((block, index) => ({ block: displayBlock(block), index }))
    .sort((left, right) => blockOrder(left.block) - blockOrder(right.block) || left.index - right.index)
    .map(({ block }) => block);
}

function recommendedTaskSummary(card: Card, blocks: CardBlock[], actions: CardAction[]): string | undefined {
  const nextDecision = blocks.find((block) => {
    const label = normalizedBlockLabel(block);
    return label === "next" || label.startsWith("next ");
  });
  const recommendedTask = blocks.find(isRecommendedTaskBlock);
  const taskSource = recommendedTask?.text
    ?? recommendedTask?.value
    ?? card.proposedAction?.instruction
    ?? actions.find((action) => action.variant === "primary")?.instruction
    ?? actions[0]?.instruction;
  const nextSource = nextDecision?.text ?? nextDecision?.value;
  if (nextSource && taskSource) {
    return `${sentenceSummary(nextSource, 1)} ${sentenceSummary(taskSource, 1)}`;
  }
  if (taskSource) {
    const summary = sentenceSummary(taskSource);
    const sentenceCount = summary.match(/[.!?](?:\s|$)/g)?.length ?? 0;
    return sentenceCount >= 2
      ? summary
      : `${summary.replace(/[.!?]*$/, ".")} Codex should stop at the approval boundary stated in this card.`;
  }
  const label = card.proposedAction?.label ?? actions.find((action) => action.variant === "primary")?.label ?? actions[0]?.label;
  return label ? `${label}. Codex should use the card's recommended task and stop at its stated approval boundary.` : undefined;
}

function BlockHeading({ block }: { block: CardBlock }) {
  if (!block.label || block.collapsible) return null;
  return <h3>{block.label}</h3>;
}

function BlockFrame({ block, children }: { block: CardBlock; children: ReactNode }) {
  if (!block.collapsible) return <>{children}</>;
  const summary = block.summary ?? block.label ?? block.title ?? "Details";
  return (
    <details className={`block-collapsible block-collapsible-${block.type}`} open={block.defaultOpen}>
      <summary className="block-summary">{summary}</summary>
      <div className="block-collapsible-body">{children}</div>
    </details>
  );
}

function Block({ feedId, cardId, block, onChanged }: { feedId: string; cardId: string; block: CardBlock; onChanged: () => void }) {
  const [value, setValue] = useState(block.value ?? "");
  useEffect(() => setValue(block.value ?? ""), [block.value]);

  const save = async () => {
    if (value === (block.value ?? "")) return;
    await post(`/api/feeds/${feedId}/cards/${cardId}/blocks/${block.id}`, { value });
    onChanged();
  };

  if (block.type === "editable_text") {
    return (
      <BlockFrame block={block}>
        <section className="block block-editor">
          <BlockHeading block={block} />
          <textarea
            aria-label={block.label ?? "Editable card content"}
            data-block-id={block.id}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void save()}
            rows={Math.max(4, value.split("\n").length + 1)}
          />
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "profile" && block.profile) {
    return (
      <BlockFrame block={block}>
        <section className="block block-profile">
          <DetachedLink className="profile-portrait" href={block.profile.href} aria-label={`Open ${block.profile.name} profile`}>
            <img
              src={block.profile.imageUrl}
              alt=""
              onError={(event) => {
                if (block.profile?.fallbackImageUrl && event.currentTarget.src !== block.profile.fallbackImageUrl) {
                  event.currentTarget.src = block.profile.fallbackImageUrl;
                }
              }}
            />
          </DetachedLink>
          <div className="profile-copy">
            <DetachedLink className="profile-name" href={block.profile.href}>{block.profile.name}</DetachedLink>
            {block.profile.subtitle && <span className="profile-subtitle">{block.profile.subtitle}</span>}
            {block.profile.links && (
              <div className="profile-links">
                {block.profile.links.map((link) => <DetachedLink key={link.href} href={link.href}>{link.label}</DetachedLink>)}
              </div>
            )}
          </div>
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "evidence") {
    return (
      <BlockFrame block={block}>
        <section className="block block-evidence">
          <BlockHeading block={block} />
          <ul>{block.items?.map((item, index) => (
            <li key={index}>
              {typeof item === "string"
                ? <FormattedText text={item} />
                : item.href
                  ? <DetachedLink href={item.href}>{item.label}</DetachedLink>
                  : <FormattedText text={item.label} />}
            </li>
          ))}</ul>
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "checklist") {
    return (
      <BlockFrame block={block}>
        <section className="block block-checklist">
          <BlockHeading block={block} />
          <ul>{block.items?.map((item, index) => <li key={index}><span className="checkmark">○</span>{typeof item === "string" ? item : item.label}</li>)}</ul>
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "options") {
    return (
      <BlockFrame block={block}>
        <section className="block block-options">
          <BlockHeading block={block} />
          {block.items?.map((item, index) => typeof item === "string"
            ? <div className="option" key={index}>{item}</div>
            : <div className="option" key={index}><b>{item.label}</b>{item.detail && <span>{item.detail}</span>}</div>)}
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "chart" && block.chart) {
    const unit = block.chart.unit ?? "";
    return (
      <BlockFrame block={block}>
        <section className="block block-chart">
          <BlockHeading block={block} />
          <div className="chart-legend">
            {block.chart.series.map((series, index) => <span key={series.label}><i className={`chart-swatch chart-series-${index + 1}`} />{series.label}</span>)}
          </div>
          <div className="chart-rows">
            {block.chart.rows.map((row) => (
              <div className="chart-row" key={row.label}>
                <div className="chart-row-label"><b>{row.label}</b>{row.detail && <span>{row.detail}</span>}</div>
                {row.values.map((value, index) => (
                  <div className="chart-metric" key={`${row.label}-${index}`} aria-label={`${row.label}: ${block.chart?.series[index].label} ${value}${unit}`}>
                    <span className="chart-value">{value}{unit}</span>
                    <span className="chart-track"><i className={`chart-bar chart-series-${index + 1}`} style={{ width: `${value / block.chart!.max * 100}%` }} /></span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {block.chart.note && <p className="chart-note">{block.chart.note}</p>}
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "diff") {
    return (
      <BlockFrame block={block}>
        <section className="block block-diff">
          <BlockHeading block={block} />
          <div className="diff-before">{block.before}</div>
          <div className="diff-after">{block.after}</div>
        </section>
      </BlockFrame>
    );
  }
  if (block.type === "clarification") {
    return (
      <BlockFrame block={block}>
        <section className="block block-clarification">{block.collapsible ? null : <h3>{block.label ?? "Needs your input"}</h3>}<p><FormattedText text={block.text} /></p></section>
      </BlockFrame>
    );
  }
  if (block.type === "receipt") {
    return (
      <BlockFrame block={block}>
        <section className="block block-receipt">{block.collapsible ? null : <h3>{block.label ?? "Done"}</h3>}<p><FormattedText text={block.text} /></p></section>
      </BlockFrame>
    );
  }
  if (block.type === "email_thread") {
    const fullEmail = containsFullEmail(block.text);
    const content = (
      <details className="block email-thread">
        <summary>{fullEmail ? "Read full email" : "Email details"} <kbd>O</kbd></summary>
        <div className="email-thread-body"><FormattedText text={block.text} /></div>
      </details>
    );
    return block.collapsible ? <BlockFrame block={block}>{content}</BlockFrame> : content;
  }
  return (
    <BlockFrame block={block}>
      <section className={`block block-${block.type}`}><BlockHeading block={block} /><p><FormattedText text={block.text} /></p></section>
    </BlockFrame>
  );
}

function QueuedNoteEditor({ work, onChanged }: { work: WorkItemView; onChanged: () => void }) {
  const [value, setValue] = useState(work.instruction);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(work.instruction), [work.instruction]);
  const save = async () => {
    const next = value.trim();
    if (!next || next === work.instruction) return;
    setSaving(true);
    try {
      await post(`/api/feeds/${work.feedId}/work/${work.id}/instruction`, { instruction: next });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="queued-note">
      <span className="action-label">Queued note</span>
      <textarea aria-label="Queued note" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => void save()} rows={Math.max(2, value.split("\n").length)} />
      <small>{saving ? "Saving..." : "Edit before Codex claims it."}</small>
    </section>
  );
}

function ContextInfluenceReceipt({ card }: { card: Card }) {
  const influence = card.contextInfluence;
  if (!influence) return null;
  const sourceCount = influence.sourceCount ?? 0;
  const signalId = influence.signalIds[0];
  return (
    <section className={`context-influence context-influence-${influence.mode}`}>
      <div className="context-influence-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
      </div>
      <div>
        <span className="context-influence-label">{influence.mode === "research" ? "Prompted by On Your Mind" : "On your mind"}</span>
        <p>{influence.summary}</p>
        {influence.researchQuestion && <small>{influence.researchQuestion}</small>}
        <a href={`/mind/${encodeURIComponent(influence.updateId)}#signal-${encodeURIComponent(signalId)}`} onClick={(event) => event.stopPropagation()}>
          View context and {sourceCount} {sourceCount === 1 ? "source" : "sources"} <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}

export function CardView({
  card,
  queuedNote,
  active,
  onActivate,
  onChanged,
  onAction,
  onHeartbeatDisposition,
  onReturnToReview,
  queuedFor,
}: {
  card: Card;
  queuedNote?: WorkItemView;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  onAction: (action: CardAction) => void;
  onHeartbeatDisposition?: (disposition: HeartbeatCardDispositionKind, parkedUntil?: string) => void;
  onReturnToReview: () => void;
  queuedFor?: string;
}) {
  const [showParkDate, setShowParkDate] = useState(false);
  const [parkedUntil, setParkedUntil] = useState("");
  const actions = visibleCardActions(card);
  const orderedBlocks = orderedCardBlocks(card.blocks);
  const heartbeatActionsAvailable = card.feedId === "anti-adhd-loose-ends-review-surface-unfinished-codex-ses" && onHeartbeatDisposition;
  const nextThing = card.proposedAction?.label === "Decide disposition"
    ? "Dismiss this card if no further work is needed. Otherwise, tell Codex the specific next step you want it to take."
    : recommendedTaskSummary(card, orderedBlocks, actions);
  return (
    <article className={`attention-card ${card.contextInfluence ? "has-context-influence" : ""} ${active ? "is-active" : ""}`} data-card-id={card.id} onClick={onActivate} onMouseEnter={onActivate}>
      <div className="card-rule" />
      <header className="card-head">
        <span className={`kind-dot ${card.kind === "feed_improvement" ? "proposal" : ""}`} />
        <div>
          <div className="eyebrow">{card.eyebrow}</div>
          <h2>{card.title}</h2>
        </div>
      </header>
      <p className="why"><FormattedText text={card.why} /></p>
      <ContextInfluenceReceipt card={card} />
      <CardHistory card={card} />
      <div className="blocks">
        {orderedBlocks.map((block) => <Block key={block.id} feedId={card.feedId} cardId={card.id} block={block} onChanged={onChanged} />)}
      </div>
      {queuedNote && <QueuedNoteEditor work={queuedNote} onChanged={onChanged} />}
      {card.status === "approved_blocked" && (
        <footer className="card-action">
          <div>
            <span className="action-label">Already approved</span>
            <b>Waiting for Codex to retry</b>
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
          </div>
        </footer>
      )}
      {actions.length > 0 && (card.status === "to_review_new" || card.status === "to_review_updated") && (
        <footer className="card-action">
          <div>
            <span className="action-label">Next thing</span>
            {nextThing && <p className="next-thing-summary">{nextThing}</p>}
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
          </div>
          <div className="action-buttons">
            {actions.map((action) => (
              <button
                aria-keyshortcuts={action.shortcut}
                aria-label={action.label}
                className={`button ${action.variant === "primary" ? "primary" : "ghost"}`}
                key={action.id}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => { event.stopPropagation(); onAction(action); }}
              >
                {action.label}{action.shortcut && <kbd aria-hidden="true">{action.shortcut.toUpperCase()}</kbd>}
              </button>
            ))}
          </div>
        </footer>
      )}
      {heartbeatActionsAvailable && (card.status === "to_review_new" || card.status === "to_review_updated") && (
        <footer className="card-action heartbeat-disposition">
          <div>
            <span className="action-label">Heartbeat status</span>
            <b>Should this loose end return later?</b>
          </div>
          <div className="heartbeat-disposition-controls">
            <div className="action-buttons">
              <button className="button ghost" onClick={(event) => { event.stopPropagation(); onHeartbeatDisposition("finished"); }}>Mark finished</button>
              <button className="button ghost" onClick={(event) => { event.stopPropagation(); onHeartbeatDisposition("closed"); }}>Close</button>
              <button className="button ghost" aria-expanded={showParkDate} onClick={(event) => { event.stopPropagation(); setShowParkDate((value) => !value); }}>Park until…</button>
            </div>
            {showParkDate && (
              <div className="park-date-control" onClick={(event) => event.stopPropagation()}>
                <label htmlFor={`park-until-${card.id}`}>Return on or after</label>
                <input id={`park-until-${card.id}`} aria-label="Park until date" type="date" value={parkedUntil} onInput={(event) => setParkedUntil(event.currentTarget.value)} />
                <button className="button primary" disabled={!parkedUntil} onClick={() => onHeartbeatDisposition("parked", parkedUntil)}>Park card</button>
              </div>
            )}
          </div>
        </footer>
      )}
      {(card.status === "queued" || card.status === "done") && (
        <footer className="card-action">
          <div>
            <span className="action-label">{card.status === "queued" ? `Queued for ${queuedFor ?? "Codex"}` : "Done"}</span>
            <b>{card.status === "queued" ? `Waiting for ${queuedFor ?? "the feed thread"}` : card.completionDisposition === "dismissed" ? "Dismissed" : card.completionDisposition === "finished" ? "Marked finished" : card.completionDisposition === "closed" ? "Closed" : card.completionDisposition === "parked" ? "Parked" : "Completed"}</b>
          </div>
          <div className="action-buttons">
            <button className="button ghost" onClick={(event) => { event.stopPropagation(); onReturnToReview(); }}>
              {card.status === "queued" ? "Move back to review" : "Review again"}
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}
