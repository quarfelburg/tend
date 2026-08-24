import { expect, test } from "bun:test";
import { visibleCards } from "../src/feed/selectors";
import type { FeedView } from "../shared/types";

test("updated cards appear in To Review even when legacy data targets a later pass", () => {
  const feed = {
    config: { currentPass: 3 },
    cards: [{
      id: "completed-card",
      status: "to_review_updated",
      readyForPass: 99,
      updatedAt: "2026-08-24T16:00:00.000Z",
      createdAt: "2026-08-24T15:00:00.000Z",
    }],
  } as FeedView;

  expect(visibleCards(feed, "review").map((card) => card.id)).toEqual(["completed-card"]);
});
