import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "../src/feed/CardView";
import type { Card } from "../shared/types";

test("renders structured evidence hrefs as clickable anchors", () => {
  const card: Card = {
    id: "linked-evidence",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Linked evidence",
    eyebrow: "Source",
    why: "The source should open from the card.",
    blocks: [{
      id: "sources",
      type: "evidence",
      label: "Sources",
      items: [{ label: "Signed agreement", href: "https://example.com/agreement" }],
    }],
    readyForPass: 1,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain('href="https://example.com/agreement"');
  expect(html).toContain(">Signed agreement</a>");
});

test("renders collapsible card blocks closed unless defaultOpen is set", () => {
  const card: Card = {
    id: "collapsible-detail",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Review loose end",
    eyebrow: "Loose ends",
    why: "The card should keep long detail behind expanders.",
    blocks: [
      { id: "next", type: "memo", label: "Next", text: "Review this one task and choose the next move." },
      { id: "analysis", type: "memo", label: "1-3-1", summary: "1-3-1 decision view", collapsible: true, text: "Problem, options, tradeoffs, and recommendation." },
      { id: "open-detail", type: "memo", label: "Open detail", collapsible: true, defaultOpen: true, text: "This starts expanded." },
    ],
    readyForPass: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("<summary");
  expect(html).toContain("1-3-1 decision view");
  expect(html).toContain('<details class="block-collapsible block-collapsible-memo">');
  expect(html).toContain('<details class="block-collapsible block-collapsible-memo" open="">');
});

test("keeps decision, risk, and source sections collapsed even when card data omits the flags", () => {
  const card: Card = {
    id: "semantic-review-expanders",
    feedId: "anti-adhd-loose-ends-review-surface-unfinished-codex-ses",
    kind: "attention",
    status: "to_review_new",
    title: "Review one current decision",
    eyebrow: "Loose ends",
    why: "Review detail should stay scannable regardless of how the card was generated.",
    blocks: [
      { id: "decision", type: "memo", label: "1-3-1 decision view", text: "Problem, options, and recommendation." },
      { id: "risks", type: "checklist", label: "Risks", defaultOpen: true, items: ["One bounded risk."] },
      { id: "sources", type: "evidence", label: "Sources", items: ["One source."] },
      { id: "verified", type: "evidence", label: "Verified state right now", items: ["Keep this section visible."] },
    ],
    readyForPass: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(<CardView card={card} onChanged={() => {}} />);

  expect(html.match(/<details class="block-collapsible/g)?.length).toBe(3);
  expect(html).toContain('<summary class="block-summary">1-3-1 decision view</summary>');
  expect(html).toContain('<summary class="block-summary">Risks</summary>');
  expect(html).toContain('<summary class="block-summary">Sources</summary>');
  expect(html).not.toContain('<details class="block-collapsible block-collapsible-checklist" open="">');
  expect(html).toContain("<h3>Verified state right now</h3>");
});

test("renders decision cards in review order with summarized history and an expanded recommended task", () => {
  const card: Card = {
    id: "decision-review-order",
    feedId: "anti-adhd-loose-ends-review-surface-unfinished-codex-ses",
    kind: "attention",
    status: "to_review_updated",
    title: "Choose the first live cycle",
    eyebrow: "Needs Hayden decision",
    why: "This evolving project needs a clear review sequence.",
    blocks: [
      { id: "sources", type: "evidence", label: "Sources", items: [
        "Current project record",
        { label: "Open HTML review", href: "/review-artifacts/cycle-review.html" },
      ] },
      { id: "risks", type: "memo", label: "Risks", collapsible: true, text: "The first cycle may be too broad." },
      { id: "task", type: "memo", label: "Exact Codex task", summary: "Exact Codex task", collapsible: true, text: "Draft three bounded candidate cycles. Compare each cycle against the same evidence and stop for Hayden's choice. Do not change canonical files." },
      { id: "decision", type: "memo", label: "1-3-1", summary: "1-3-1 decision view", collapsible: true, text: "Problem, options, hybrids, and recommendation." },
      { id: "next", type: "memo", label: "Next", text: "Choose the first cycle to test." },
    ],
    proposedAction: { label: "Draft options", instruction: "Draft three bounded candidate cycles." },
    readyForPass: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    history: [
      {
        at: "2026-08-18T11:00:00.000Z",
        type: "codex.completed",
        detail: "Older cycle set that should stay behind the full-history expander.",
      },
      {
        at: "2026-08-20T10:45:00.000Z",
        type: "user.instruction",
        detail: "Draft the latest three bounded cycles and stop for my choice.",
      },
      {
        at: "2026-08-20T11:00:00.000Z",
        type: "codex.completed",
        detail: "Three candidate first live cycles were drafted: 1. Fact: Dense implementation detail that belongs behind the expander. Decision: Choose the first cycle. Recommendation: Start with the evidence recovery cycle. Hayden choice required: 1, 2, or 3.",
      },
    ],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Three candidate first live cycles were drafted. Recommendation: Start with the evidence recovery cycle.");
  expect(html).toContain("Draft the latest three bounded cycles and stop for my choice.");
  expect(html).not.toContain("Older cycle set that should stay behind the full-history expander.");
  expect(html).toContain('<time dateTime="2026-08-20T10:45:00.000Z">');
  expect(html).toContain('<time dateTime="2026-08-20T11:00:00.000Z">');
  expect(html).not.toContain("Dense implementation detail that belongs behind the expander");
  expect(html).not.toContain("Exact Codex task");
  expect(html).toContain("Recommended Codex task");
  expect(html).toContain('<details class="block-collapsible block-collapsible-memo" open="">');
  expect(html).toContain("Draft three bounded candidate cycles. Compare each cycle against the same evidence and stop for Hayden&#x27;s choice.");
  expect(html).toContain("Choose the first cycle to test. Draft three bounded candidate cycles.");
  expect(html).toContain("Chat about this task");
  expect(html.indexOf("Next thing")).toBeLessThan(html.indexOf("Chat about this task"));
  expect(html).toContain('<a href="/review-artifacts/cycle-review.html"');
  expect(html.match(/Open HTML review/g)?.length).toBe(2);

  const historyIndex = html.indexOf("Card history summary");
  const nextIndex = html.indexOf(">Next<");
  const decisionIndex = html.indexOf("1-3-1 decision view");
  const taskIndex = html.indexOf("Recommended Codex task");
  const risksIndex = html.indexOf(">Risks<");
  const sourcesIndex = html.indexOf(">Sources<");
  const actionIndex = html.indexOf("Next thing");
  expect(historyIndex).toBeGreaterThan(-1);
  expect(historyIndex).toBeLessThan(nextIndex);
  expect(nextIndex).toBeLessThan(decisionIndex);
  expect(decisionIndex).toBeLessThan(taskIndex);
  expect(taskIndex).toBeLessThan(risksIndex);
  expect(risksIndex).toBeLessThan(sourcesIndex);
  expect(sourcesIndex).toBeLessThan(actionIndex);
});

test("places OKR context before Next while preserving the Loose Ends review hierarchy", () => {
  const card: Card = {
    id: "personal-okr",
    feedId: "personal-okrs",
    kind: "attention",
    status: "to_review_new",
    title: "Review objective progress",
    eyebrow: "Personal OKRs",
    why: "The objective needs a current evidence decision.",
    blocks: [
      { id: "next", type: "memo", label: "Next", text: "Choose the next evidence pass." },
      { id: "risks", type: "checklist", label: "Risks", items: ["Do not infer results."] },
      { id: "okr-context", type: "memo", label: "Objective and key results", text: "Objective: Validate the result." },
      { id: "codex-task", type: "memo", label: "Recommended Codex task", summary: "Reconcile the current evidence and propose the next decision.", text: "Reconcile evidence." },
    ],
    readyForPass: 1,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    history: [],
  };
  const html = renderToStaticMarkup(<CardView
    card={card}
    onChanged={() => {}}
  />);

  expect(html.indexOf("Objective and key results")).toBeLessThan(html.indexOf(">Next<"));
  expect(html.indexOf(">Next<")).toBeLessThan(html.indexOf("Reconcile the current evidence"));
});

test("places project context before Next while preserving the shared review hierarchy", () => {
  const card: Card = {
    id: "active-project",
    feedId: "active-projects",
    kind: "attention",
    status: "to_review_new",
    title: "Move the project forward",
    eyebrow: "Active Projects",
    why: "The project needs one current decision.",
    blocks: [
      { id: "next", type: "memo", label: "Next", text: "Choose the next project step." },
      { id: "risks", type: "checklist", label: "Risks", items: ["Do not duplicate execution."] },
      { id: "project-context", type: "memo", label: "Project", text: "Status: In progress\n\nNext step: Define the reusable operator boundary." },
      { id: "codex-task", type: "memo", label: "Recommended Codex task", summary: "Draft the operator boundary and return the architecture choice.", text: "Draft the operator boundary." },
    ],
    readyForPass: 1,
    createdAt: "2026-08-20T14:00:00.000Z",
    updatedAt: "2026-08-20T14:00:00.000Z",
    history: [],
  };
  const html = renderToStaticMarkup(<CardView card={card} onChanged={() => {}} />);

  expect(html.indexOf(">Project<")).toBeLessThan(html.indexOf(">Next<"));
  expect(html.indexOf(">Next<")).toBeLessThan(html.indexOf("Draft the operator boundary and return the architecture choice"));
});

test("renders a visible lens receipt for a context-influenced card", () => {
  const card: Card = {
    id: "paywall-context",
    feedId: "every-performance",
    kind: "attention",
    status: "to_review_new",
    title: "Mobile paywall behavior deserves a closer look.",
    eyebrow: "Every Performance",
    why: "A current metric now connects to the active paywall diagnosis.",
    sourceRunIds: ["run-current"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "lens",
      effect: "prioritized",
      summary: "Prioritized because paywall diagnosis is an active decision.",
      sourceCount: 3,
    },
    blocks: [{ id: "brief", type: "memo", text: "Source-backed metric detail." }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("On your mind");
  expect(html).toContain("Prioritized because paywall diagnosis is an active decision.");
  expect(html).toContain('href="/mind/mind-current#signal-paywall"');
  expect(html).toContain("View context and 3 sources");
});

test("labels context-originated research separately from source evidence", () => {
  const card: Card = {
    id: "paywall-research",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Three evidence-backed paywall improvements.",
    eyebrow: "Company Attention",
    why: "A bounded research pass found relevant patterns.",
    sourceRunIds: ["run-research"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "research",
      effect: "selected",
      summary: "Prompted by the active paywall work.",
      researchQuestion: "What evidence-backed paywall improvements fit Every?",
      sourceCount: 2,
    },
    blocks: [{ id: "sources", type: "evidence", items: ["Independent research source"] }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Prompted by On Your Mind");
  expect(html).toContain("What evidence-backed paywall improvements fit Every?");
});

test("injects a local Dismiss card control by default instead of Archive", () => {
  const card: Card = {
    id: "plain",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Nothing urgent",
    eyebrow: "Inbox",
    why: "You can clear this from review without touching the source.",
    blocks: [{ id: "memo", type: "memo", text: "No action needed." }],
    readyForPass: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Dismiss card");
  expect(html).not.toContain("Archive");
});

test("keeps local dismissal alongside explicitly proposed source cleanup", () => {
  const card: Card = {
    id: "cleanup",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Routine notice",
    eyebrow: "Inbox",
    why: "This thread can be archived at the source.",
    blocks: [{ id: "memo", type: "memo", text: "Routine." }],
    proposedAction: { label: "Archive this thread", instruction: "Archive the email thread." },
    readyForPass: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Dismiss card");
  expect(html).toContain("Archive");
});

test("shows explicit loose-end heartbeat controls without changing Dismiss card", () => {
  const card: Card = {
    id: "loose-end",
    feedId: "anti-adhd-loose-ends-review-surface-unfinished-codex-ses",
    kind: "attention",
    status: "to_review_new",
    title: "Unfinished contract review",
    eyebrow: "Loose ends",
    why: "This still needs a decision.",
    blocks: [{ id: "next", type: "memo", text: "Review the open decision." }],
    readyForPass: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onHeartbeatDisposition={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Dismiss card");
  expect(html).toContain("Mark finished");
  expect(html).toContain(">Close<");
  expect(html).toContain("Park until");
  expect(html).not.toContain("Park card");
});
