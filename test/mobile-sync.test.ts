import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { mobileCloudConfigFromEnv, normalizeMobileCommand, type MobileCloudClient } from "../server/mobile/client";
import { projectMobileWorkspace } from "../server/mobile/projection";
import { MobileSyncWorker } from "../server/mobile/sync";
import { AttentionStore } from "../server/store";
import type { MobileCommand, MobileCommandProgress, MobileWorkspaceSnapshot } from "../shared/mobile";

const roots: string[] = [];
const SYNC_COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_COMMAND_ID = "22222222-2222-4222-8222-222222222222";

class FakeCloud implements MobileCloudClient {
  snapshots: MobileWorkspaceSnapshot[] = [];
  commands: MobileCommand[] = [];
  completed: Array<{ id: string; state: string; workId?: string; error?: string }> = [];
  progress: MobileCommandProgress[] = [];
  failNextPush = false;

  async replaceSnapshot(snapshot: MobileWorkspaceSnapshot): Promise<void> {
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("offline");
    }
    this.snapshots.push(snapshot);
  }

  async claimCommands(): Promise<MobileCommand[]> {
    return this.commands.splice(0);
  }

  async completeCommand(id: string, state: "applied" | "rejected", result: { workId?: string; error?: string }): Promise<void> {
    this.completed.push({ id, state, ...result });
  }

  async syncCommandProgress(progress: MobileCommandProgress[]): Promise<void> {
    this.progress = progress;
  }
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-mobile-sync-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.bindFeed("inbox", "thread-inbox");
  await domain.upsertCard("inbox", {
    id: "phone-review",
    title: "Review this on iPhone.",
    why: "The bridge should preserve the exact card.",
    blocks: [{ id: "memo", type: "memo", text: "A useful decision." }],
  });
  return { store, domain };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mobile sync worker", () => {
  test("mirrors every feed, imports commands, and reflects work progress", async () => {
    const { store, domain } = await setup();
    await domain.createFeedFromBrief("Every\nReview Every signals.", null);
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "phone-review")!;
    const cloud = new FakeCloud();
    cloud.commands.push({
      id: SYNC_COMMAND_ID,
      userId: "user-1",
      clientRequestId: "request-sync",
      deviceId: "iphone",
      feedId: "inbox",
      cardId: "phone-review",
      feedGeneration: projection.feedGeneration,
      expectedCardDigest: projection.cardDigest,
      kind: "instruction",
      instruction: "Research the strongest option.",
      state: "claimed",
      createdAt: "2026-06-13T18:00:00.000Z",
      availableAt: "2026-06-13T18:00:00.000Z",
    });
    const worker = new MobileSyncWorker(store, domain, cloud);

    const first = await worker.runOnce();
    const imported = (await store.readWorkItems("inbox")).find((work) => work.sourceMobileCommandId === SYNC_COMMAND_ID)!;
    imported.status = "completed";
    imported.response = "Saved at /Users/dan/private.txt with secret=private-value";
    await store.writeWork(imported);
    await worker.runOnce();

    expect(first.lastError).toBeUndefined();
    expect(cloud.snapshots[0].feeds.map((feed) => feed.id)).toEqual(["inbox", "every"]);
    expect(cloud.completed).toEqual([{ id: SYNC_COMMAND_ID, state: "applied", workId: expect.any(String) }]);
    expect(cloud.progress).toEqual([
      expect.objectContaining({
        commandId: SYNC_COMMAND_ID,
        workStatus: "completed",
        response: "Saved at /Users/[REDACTED]/private.txt with [REDACTED SECRET]",
      }),
    ]);
  });

  test("recovers after a cloud outage without duplicating imported work", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "phone-review")!;
    const cloud = new FakeCloud();
    cloud.failNextPush = true;
    const command: MobileCommand = {
      id: RETRY_COMMAND_ID,
      userId: "user-1",
      clientRequestId: "request-retry",
      deviceId: "iphone",
      feedId: "inbox",
      cardId: "phone-review",
      feedGeneration: projection.feedGeneration,
      expectedCardDigest: projection.cardDigest,
      kind: "instruction",
      instruction: "Bring back a concise answer.",
      state: "claimed",
      createdAt: "2026-06-13T18:00:00.000Z",
      availableAt: "2026-06-13T18:00:00.000Z",
    };
    cloud.commands.push(command);
    const worker = new MobileSyncWorker(store, domain, cloud);

    expect((await worker.runOnce()).lastError).toContain("offline");
    expect((await worker.runOnce()).lastError).toBeUndefined();
    cloud.commands.push(command);
    await worker.runOnce();

    expect((await store.readWorkItems("inbox")).filter((work) => work.sourceMobileCommandId === RETRY_COMMAND_ID)).toHaveLength(1);
    expect(cloud.completed.filter((item) => item.id === RETRY_COMMAND_ID)).toHaveLength(2);
  });
});

describe("mobile cloud configuration", () => {
  test("requires a stable worker id whenever mobile sync is enabled", () => {
    expect(mobileCloudConfigFromEnv({})).toBeNull();
    expect(() => mobileCloudConfigFromEnv({
      TEND_MOBILE_SUPABASE_URL: "https://example.supabase.co",
      TEND_MOBILE_SUPABASE_SECRET_KEY: "secret",
      TEND_MOBILE_USER_ID: "00000000-0000-0000-0000-000000000001",
    })).toThrow("TEND_MOBILE_WORKER_ID");
    expect(mobileCloudConfigFromEnv({
      TEND_MOBILE_SUPABASE_URL: "https://example.supabase.co/",
      TEND_MOBILE_SUPABASE_SECRET_KEY: "secret",
      TEND_MOBILE_USER_ID: "00000000-0000-0000-0000-000000000001",
      TEND_MOBILE_WORKER_ID: "canonical-mac",
    })).toEqual({
      url: "https://example.supabase.co",
      secretKey: "secret",
      userId: "00000000-0000-0000-0000-000000000001",
      workerId: "canonical-mac",
    });
  });

  test("rejects malformed structured edits instead of approving unchanged text", () => {
    expect(() => normalizeMobileCommand({
      id: SYNC_COMMAND_ID,
      user_id: "user-1",
      client_request_id: "request-sync",
      device_id: "iphone",
      feed_id: "inbox",
      card_id: "phone-review",
      feed_generation: "generation",
      expected_card_digest: "digest",
      kind: "approve_action",
      state: "claimed",
      created_at: "2026-06-13T18:00:00.000Z",
      available_at: "2026-06-13T18:00:00.000Z",
      payload: { edits: { draft: 42 } },
    })).toThrow("Invalid mobile command edits");
  });
});
