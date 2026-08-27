import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import App from "../src/App";
import { CardView } from "../src/feed/CardView";
import type { Card, FeedView, HeartbeatCardDispositionKind, WorkspaceView } from "../shared/types";

GlobalRegistrator.register();

class StubEventSource {
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  close() {}
}

Object.assign(globalThis, { EventSource: StubEventSource });

afterEach(() => cleanup());

function workspace(): WorkspaceView {
  const card: Card = {
    id: "cleanup-card",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Routine notice",
    eyebrow: "Inbox",
    why: "This card can be dismissed locally or archived at the source.",
    blocks: [],
    proposedAction: { label: "Archive", instruction: "Archive the source thread." },
    readyForPass: 1,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    history: [],
  };
  const active: FeedView = {
    config: {
      id: "inbox",
      name: "Inbox",
      purpose: "Review inbox attention.",
      defaultCleanup: "Archive the source thread.",
      currentPass: 1,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    },
    thread: {
      homeThreadId: "thread-codex",
      boundAt: "2026-07-13T12:00:00.000Z",
      heartbeat: { status: "not_proposed", cadence: null, automationId: null },
    },
    sources: [],
    policy: "",
    cards: [card],
    runs: [],
    routineActions: [],
    work: [],
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 },
    readyNextPass: 0,
  };
  return {
    feeds: [{ id: "inbox", name: "Inbox", purpose: "Review inbox attention." }],
    active,
    agents: { claude: { liveness: "offline", lastSeenAt: null } },
    dictation: {
      provider: null,
      status: "not_checked",
      activationCode: "AltRight",
      activationLabel: "Right Option",
      source: "fallback",
      detectedAt: null,
      note: "",
    },
    proposals: [],
  };
}

test("App keeps local dismissal and source cleanup undo requests distinct", async () => {
  const requests: string[] = [];
  let failNextCleanupUndo = true;
  const state = workspace();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") requests.push(url);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url.endsWith("/actions/dismiss-card")) return Response.json({ id: "dismissed-card" });
    if (url.endsWith("/actions/default-cleanup")) return Response.json({ id: "cleanup-work" });
    if (url.endsWith("/undo-cleanup-source") && failNextCleanupUndo) {
      failNextCleanupUndo = false;
      return Response.json({ error: "Temporary cleanup undo failure" }, { status: 503 });
    }
    if (url.endsWith("/return-to-review") || url.endsWith("/undo-cleanup-source")) return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <App feedId="inbox" screen="feed" workspaceTab="feed" />,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

  fireEvent.click(await view.findByRole("button", { name: "Dismiss card" }));
  await waitFor(() => expect(requests).toContain("/api/feeds/inbox/cards/cleanup-card/actions/dismiss-card"));
  fireEvent.click(view.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(requests).toContain("/api/feeds/inbox/cards/cleanup-card/actions/default-cleanup"));
  expect(await view.findAllByRole("button", { name: "Undo" })).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  await view.findByText("Temporary cleanup undo failure");
  expect(view.getByRole("button", { name: "Undo" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(requests.filter((url) => url.endsWith("/undo-cleanup-source"))).toHaveLength(2));
  expect(requests).not.toContain("/api/feeds/inbox/cards/cleanup-card/return-to-review");

  fireEvent.click(view.getByRole("button", { name: "Dismiss card" }));
  fireEvent.click(await view.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(requests).toContain("/api/feeds/inbox/cards/cleanup-card/return-to-review"));
});

test("Top Priorities shows the Tend dock scoped to the source card", async () => {
  sessionStorage.clear();
  const state = workspace();
  const sourceCard = state.active.cards[0];
  state.feeds = [
    { id: "top-priorities", name: "Top Priorities", purpose: "Review the highest-priority work." },
    ...state.feeds,
  ];
  state.active = {
    ...state.active,
    config: {
      ...state.active.config,
      id: "top-priorities",
      name: "Top Priorities",
      purpose: "Review the highest-priority work.",
    },
    thread: {
      homeThreadId: null,
      boundAt: null,
      heartbeat: { status: "not_proposed", cadence: null, automationId: null },
    },
    cards: [{ ...sourceCard, priority: {
      feedId: "inbox",
      cardId: sourceCard.id,
      sourceFeedName: "Inbox",
      sourceUpdatedAt: sourceCard.updatedAt,
      dimensions: { impact: 25, costOfDelay: 20, strategicAlignment: 20, leverage: 20 },
      rationales: { impact: "Material.", costOfDelay: "Timely.", strategicAlignment: "Aligned.", leverage: "Unlocking." },
      confidence: "high",
      effort: "small",
      clusterKey: "inbox-routine",
      missingEvidence: [],
      scoredAt: sourceCard.updatedAt,
      scoredBy: "agent",
      baseScore: 85,
      recencyPenalty: 0,
      score: 85,
      stale: false,
    } }],
    sources: [],
    policy: "This is a live projection.",
  };
  const targetChanges: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=top-priorities") return Response.json(state);
    if (url === "/api/voice/target-change") {
      const body = JSON.parse(String(init?.body));
      targetChanges.push(body);
      return Response.json(body.target);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <App feedId="top-priorities" screen="feed" workspaceTab="feed" />,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

  expect(await view.findByLabelText("Instruction for Codex")).toBeTruthy();
  expect(view.getByText("Talking to:")).toBeTruthy();
  expect(view.getAllByText("Routine notice").length).toBeGreaterThan(0);
  await waitFor(() => expect(targetChanges.length).toBeGreaterThan(0));
  expect(targetChanges.at(-1)).toMatchObject({
    feedId: "inbox",
    target: { kind: "card", feedId: "inbox", cardId: "cleanup-card" },
  });
});

function looseEndCard(): Card {
  return {
    id: "loose-end",
    feedId: "anti-adhd-loose-ends-review-surface-unfinished-codex-ses",
    kind: "attention",
    status: "to_review_new",
    title: "Review this loose end",
    eyebrow: "Loose ends",
    why: "This still needs a clear status.",
    blocks: [{ id: "next", type: "memo", text: "Choose the next move." }],
    readyForPass: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    history: [],
  };
}

test("park until requires a date and submits the explicit parked disposition", () => {
  const calls: Array<{ disposition: HeartbeatCardDispositionKind; parkedUntil?: string }> = [];
  const view = render(
    <CardView
      card={looseEndCard()}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onHeartbeatDisposition={(disposition, parkedUntil) => calls.push({ disposition, parkedUntil })}
      onReturnToReview={() => {}}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Park until…" }));
  const confirm = view.getByRole("button", { name: "Park card" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);

  fireEvent.input(view.getByLabelText("Park until date"), { target: { value: "2026-09-15" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);

  expect(calls).toEqual([{ disposition: "parked", parkedUntil: "2026-09-15" }]);
});

test("finished and closed are separate from local dismissal", () => {
  const calls: HeartbeatCardDispositionKind[] = [];
  const view = render(
    <CardView
      card={looseEndCard()}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onHeartbeatDisposition={(disposition) => calls.push(disposition)}
      onReturnToReview={() => {}}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Mark finished" }));
  fireEvent.click(view.getByRole("button", { name: "Close" }));

  expect(calls).toEqual(["finished", "closed"]);
  expect(view.getByRole("button", { name: "Dismiss card" })).toBeTruthy();
});

test("history expands from a quick summary into readable paragraph detail", () => {
  const card = looseEndCard();
  card.history = [{
    at: "2026-08-20T11:00:00.000Z",
    type: "codex.completed",
    detail: "Three candidate cycles were drafted: 1. Fact: The evidence is incomplete. Decision: Reconcile the board. 2. Fact: Delivery readiness is unclear. Decision: Build a readiness gate. Recommendation: Start with evidence recovery. Hayden choice required: 1 or 2.",
  }];
  const view = render(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(view.getByLabelText("Card history summary")).toBeTruthy();
  expect(view.queryByText(/The evidence is incomplete/)).toBeNull();

  fireEvent.click(view.getByRole("button", { name: /Expand full history/ }));

  expect(view.getByLabelText("Full card history")).toBeTruthy();
  expect(view.getByText(/The evidence is incomplete/)).toBeTruthy();
  expect(view.container.querySelectorAll(".history-detail-full br").length).toBeGreaterThan(1);
});
