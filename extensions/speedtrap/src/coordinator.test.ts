import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeedtrapCoordinator, resetSharedState } from "./coordinator.js";
import type { SpeedtrapConfig } from "./types.js";

function createCoordinator(overrides: Partial<SpeedtrapConfig> = {}): {
  coordinator: SpeedtrapCoordinator;
  logs: string[];
} {
  const logs: string[] = [];
  const config: SpeedtrapConfig = {
    assumeUnknownToolsAreWrites: true,
    debug: true,
    maxReinjects: 3,
    coalesce: false,
    claimWhileActive: false,
    maxBufferedMessages: 20,
    pendingTtlMs: 900_000,
    ...overrides,
  };
  const coordinator = new SpeedtrapCoordinator(config, (msg) => logs.push(msg));
  return { coordinator, logs };
}

describe("SpeedtrapCoordinator", () => {
  beforeEach(() => {
    resetSharedState();
  });

  // ===========================================================================
  // v1 behavior (coalesce=false, default)
  // ===========================================================================

  describe("channel unchanged → deliver", () => {
    it("delivers when no new messages arrived after agent start", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("deliver");
    });

    it("delivers when agent starts before any messages on channel", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("deliver");
    });
  });

  describe("channel moved, no writes → suppress", () => {
    it("suppresses when channel moved and agent had no write side effects", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("suppress");
    });

    it("suppresses when agent only used read-only tools", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onToolCall("agent-a", "ch:1", "web_search");
      coordinator.onToolCall("agent-a", "ch:1", "file_read");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("suppress");
    });

    it("suppresses when multiple messages arrive during processing", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("suppress");
    });
  });

  describe("channel moved, has writes → reinject", () => {
    it("reinjects when agent had write side effects and channel moved", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "I wrote to config.json");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("write_file");
        expect(decision.context).toContain("I wrote to config.json");
        expect(decision.context).toContain("CHANNEL MOVED");
      }
    });

    it("reinjects when unknown tool used with assumeUnknownToolsAreWrites=true", () => {
      const { coordinator } = createCoordinator({ assumeUnknownToolsAreWrites: true });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "some_custom_tool");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "done");

      expect(decision.action).toBe("reinject");
    });

    it("deduplicates tool names in reinjection context", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "done");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("write_file, bash");
      }
    });
  });

  describe("assumeUnknownToolsAreWrites=false", () => {
    it("suppresses when unknown tool used with assumeUnknownToolsAreWrites=false", () => {
      const { coordinator } = createCoordinator({ assumeUnknownToolsAreWrites: false });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "some_custom_tool");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "done");

      expect(decision.action).toBe("suppress");
    });
  });

  describe("thundering herd scenario", () => {
    it("fastest agent delivers, slower agents get discarded", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");
      coordinator.onAgentStart("agent-c", "ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp-a").action).toBe("deliver");

      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-b", "ch:1", "resp-b").action).toBe("suppress");
      expect(coordinator.getDecision("agent-c", "ch:1", "resp-c").action).toBe("suppress");
    });
  });

  describe("cascade self-extinguishing", () => {
    it("cascade-triggered runs get discarded as channel keeps moving", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");

      coordinator.onAgentStart("agent-a", "ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("deliver");

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");

      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-b", "ch:1", "resp").action).toBe("suppress");
    });
  });

  describe("no tracked run → deliver (conservative)", () => {
    it("delivers when no run state exists for the agent", () => {
      const { coordinator } = createCoordinator();

      const decision = coordinator.getDecision("unknown-agent", "ch:1", "resp");
      expect(decision.action).toBe("deliver");
    });
  });

  describe("multi-channel isolation", () => {
    it("channel movement on one channel does not affect another", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:2");

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:2");

      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("suppress");
      expect(coordinator.getDecision("agent-b", "ch:2", "resp").action).toBe("deliver");
    });
  });

  describe("same agent, different channels", () => {
    it("tracks runs per channel independently", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:2");

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-a", "ch:2");

      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("suppress");
      expect(coordinator.getDecision("agent-a", "ch:2", "resp").action).toBe("deliver");
    });
  });

  describe("run state cleanup", () => {
    it("cleans up run state after getDecision", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.getDecision("agent-a", "ch:1", "resp");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("deliver");
    });
  });

  describe("debug logging", () => {
    it("logs suppress decisions", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onMessageReceived("ch:1");
      coordinator.getDecision("agent-a", "ch:1", "resp");

      expect(logs.some((l) => l.includes("Agent agent-a started on ch:1"))).toBe(true);
      expect(logs).toContain("Agent agent-a tool call: memory_search (classified as read)");
      expect(logs.some((l) => l.includes("channel moved, no writes, suppressing"))).toBe(true);
    });

    it("logs reinject decisions", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");
      coordinator.getDecision("agent-a", "ch:1", "resp");

      expect(logs.some((l) => l.includes("channel moved, has writes, reinjecting (1/3)"))).toBe(
        true,
      );
    });

    it("logs dirty marking on receive", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1");

      expect(logs.some((l) => l.includes("marked 1 active run(s) dirty"))).toBe(true);
    });
  });

  describe("reinject budget exhaustion", () => {
    it("delivers after maxReinjects is reached", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 2 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      // Re-dirty: reinject resets the flag, so the channel must move again
      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");

      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-3").action).toBe("deliver");
    });

    it("cleans up run state after budget exhaustion", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 1 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("deliver");

      // Run was cleaned up, so "no tracked run" -> deliver
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-3").action).toBe("deliver");
    });

    it("preserves write tool tracking across reinjects", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 2 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");
      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("write_file");
      }
    });
  });

  describe("run state cleanup on reinject vs deliver/suppress", () => {
    it("keeps run state alive during reinject cycle", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 3 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");
    });
  });

  describe("triggering message does not cause false positive", () => {
    it("message before agent start does not count as channel moved", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("deliver");
    });
  });

  // ===========================================================================
  // v2 coalescing behavior (coalesce=true)
  // ===========================================================================

  describe("inbound_claim: claim gating", () => {
    it("does not claim when coalesce is disabled", () => {
      const { coordinator } = createCoordinator({ coalesce: false, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      const claimed = coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      expect(claimed).toBe(false);
    });

    it("does not claim when claimWhileActive is disabled", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: false });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      const claimed = coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      expect(claimed).toBe(false);
    });

    it("does not claim when no active run exists", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      const claimed = coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      expect(claimed).toBe(false);
    });

    it("claims when active run exists for same agent+channel", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      const claimed = coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      expect(claimed).toBe(true);
    });

    it("claims for a different agent on the same channel (any active run)", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      const claimed = coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      expect(claimed).toBe(true);
    });

    it("does not claim on a different channel", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      const claimed = coordinator.onInboundClaim("ch:2", { content: "follow-up" });
      expect(claimed).toBe(false);
    });
  });

  describe("overlap merge: coalesced reinjection", () => {
    it("reinjects with buffered follow-ups when channel moved and no writes", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.onInboundClaim("ch:1", { content: "also do X" });
      coordinator.onInboundClaim("ch:1", { content: "and Y" });

      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "original draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("also do X");
        expect(decision.context).toContain("and Y");
        expect(decision.context).toContain("original draft");
        expect(decision.context).toContain("Buffered follow-up messages");
      }
    });

    it("includes sender in coalesced reinjection context", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.onInboundClaim("ch:1", { content: "hello", sender: "alice" });
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("[alice]");
      }
    });

    it("reinjects with both writes and pending follow-ups", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onInboundClaim("ch:1", { content: "wait also do Z" });
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "I wrote config");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("write_file");
        expect(decision.context).toContain("wait also do Z");
        expect(decision.context).toContain("I wrote config");
      }
    });
  });

  describe("no-followup stale read-only → suppress (coalesce=true)", () => {
    it("suppresses when channel moved, no writes, no pending", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "stale response");
      expect(decision.action).toBe("suppress");
    });
  });

  describe("writes stale → reinject with write confirmation (coalesce=true)", () => {
    it("reinjects with write tool list when channel moved and writes occurred", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onMessageReceived("ch:1");

      const decision = coordinator.getDecision("agent-a", "ch:1", "executed commands");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("bash, write_file");
        expect(decision.context).toContain("write operations");
        expect(decision.context).toContain("already happened");
      }
    });
  });

  describe("buffer bounds and TTL", () => {
    it("enforces maxBufferedMessages as a ring buffer", () => {
      const { coordinator } = createCoordinator({
        coalesce: true,
        claimWhileActive: true,
        maxBufferedMessages: 3,
      });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.onInboundClaim("ch:1", { content: "msg-1" });
      coordinator.onInboundClaim("ch:1", { content: "msg-2" });
      coordinator.onInboundClaim("ch:1", { content: "msg-3" });
      coordinator.onInboundClaim("ch:1", { content: "msg-4" });

      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        // msg-1 should have been dropped (oldest)
        expect(decision.context).not.toContain("msg-1");
        expect(decision.context).toContain("msg-2");
        expect(decision.context).toContain("msg-3");
        expect(decision.context).toContain("msg-4");
      }
    });

    it("prunes expired pending entries by TTL", () => {
      vi.useFakeTimers();
      try {
        const { coordinator } = createCoordinator({
          coalesce: true,
          claimWhileActive: true,
          pendingTtlMs: 1000,
        });

        coordinator.onMessageReceived("ch:1");
        coordinator.onAgentStart("agent-a", "ch:1");

        coordinator.onInboundClaim("ch:1", { content: "old-msg", ts: Date.now() });

        vi.advanceTimersByTime(1500);

        coordinator.onInboundClaim("ch:1", { content: "fresh-msg", ts: Date.now() });

        coordinator.onMessageReceived("ch:1");
        const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

        expect(decision.action).toBe("reinject");
        if (decision.action === "reinject") {
          expect(decision.context).not.toContain("old-msg");
          expect(decision.context).toContain("fresh-msg");
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("suppresses when all pending entries have expired", () => {
      vi.useFakeTimers();
      try {
        const { coordinator } = createCoordinator({
          coalesce: true,
          claimWhileActive: true,
          pendingTtlMs: 1000,
        });

        coordinator.onMessageReceived("ch:1");
        coordinator.onAgentStart("agent-a", "ch:1");

        coordinator.onInboundClaim("ch:1", { content: "old-msg", ts: Date.now() });

        vi.advanceTimersByTime(1500);

        coordinator.onMessageReceived("ch:1");
        const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

        expect(decision.action).toBe("suppress");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("budget exhaustion with coalescing", () => {
    it("delivers after maxReinjects even with pending follow-ups", () => {
      const { coordinator } = createCoordinator({
        coalesce: true,
        claimWhileActive: true,
        maxReinjects: 1,
      });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      coordinator.onMessageReceived("ch:1");

      // First call: reinject (pending follow-ups, budget not exhausted)
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");

      // Second call: budget exhausted, forced delivery
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("deliver");
    });

    it("delivers after maxReinjects with writes + coalescing", () => {
      const { coordinator } = createCoordinator({
        coalesce: true,
        claimWhileActive: true,
        maxReinjects: 2,
      });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");
      coordinator.onMessageReceived("ch:1");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-3").action).toBe("deliver");
    });
  });

  describe("isolation with coalescing", () => {
    it("pending buffer is per-agent-run, not per-channel", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");

      // Claim distributes to both active runs
      coordinator.onInboundClaim("ch:1", { content: "follow-up" });
      coordinator.onMessageReceived("ch:1");

      // Agent A reinjects (consumes its own buffer)
      const dA = coordinator.getDecision("agent-a", "ch:1", "resp-a");
      expect(dA.action).toBe("reinject");
      if (dA.action === "reinject") {
        expect(dA.context).toContain("follow-up");
      }

      // Agent B still has the message in its own buffer
      const dB = coordinator.getDecision("agent-b", "ch:1", "resp-b");
      expect(dB.action).toBe("reinject");
      if (dB.action === "reinject") {
        expect(dB.context).toContain("follow-up");
      }
    });

    it("same agent on different channels has independent claim state", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      // Claim on ch:1 succeeds
      expect(coordinator.onInboundClaim("ch:1", { content: "msg" })).toBe(true);

      // Claim on ch:2 fails (no active run)
      expect(coordinator.onInboundClaim("ch:2", { content: "msg" })).toBe(false);
    });
  });

  describe("per-agent buffer lifecycle", () => {
    it("consuming buffer on reinject does not affect other agents", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");
      coordinator.onInboundClaim("ch:1", { content: "msg-1" });
      coordinator.onMessageReceived("ch:1");

      // Agent A reinjects and consumes its buffer
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-a").action).toBe("reinject");

      // Agent A's dirty flag was reset by reinject. No new messages arrived,
      // so the re-run's response is fresh and should deliver.
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-a2").action).toBe("deliver");

      // Agent B still has msg-1 in its own buffer
      const dB = coordinator.getDecision("agent-b", "ch:1", "draft-b");
      expect(dB.action).toBe("reinject");
      if (dB.action === "reinject") {
        expect(dB.context).toContain("msg-1");
      }
    });

    it("new run starts with empty buffer", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onInboundClaim("ch:1", { content: "old-msg" });

      // Agent A delivers (channel unchanged), run cleaned up
      coordinator.getDecision("agent-a", "ch:1", "resp");

      // New run starts fresh, no leftover buffer
      coordinator.onAgentStart("agent-b", "ch:1");
      coordinator.onMessageReceived("ch:1");
      const decision = coordinator.getDecision("agent-b", "ch:1", "resp");
      expect(decision.action).toBe("suppress");
    });
  });

  describe("coalesced herd scenario", () => {
    it("fastest delivers, overlap gets single coalesced reinject for writes", () => {
      const { coordinator } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");

      // Agent B does writes
      coordinator.onToolCall("agent-b", "ch:1", "write_file");

      // Agent A finishes first → deliver
      expect(coordinator.getDecision("agent-a", "ch:1", "resp-a").action).toBe("deliver");

      // Agent A's response is a new message
      coordinator.onMessageReceived("ch:1");

      // Agent B finishes: channel moved + writes → reinject
      const decision = coordinator.getDecision("agent-b", "ch:1", "resp-b");
      expect(decision.action).toBe("reinject");
    });
  });

  describe("claim logging", () => {
    it("logs claimed inbound messages", () => {
      const { coordinator, logs } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onInboundClaim("ch:1", { content: "hello" });

      expect(
        logs.some(
          (l) => l.includes("Claimed inbound") && l.includes("distributed to 1 active run"),
        ),
      ).toBe(true);
    });

    it("logs pending-followup reinject decisions", () => {
      const { coordinator, logs } = createCoordinator({ coalesce: true, claimWhileActive: true });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onInboundClaim("ch:1", { content: "msg" });
      coordinator.onMessageReceived("ch:1");
      coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(
        logs.some(
          (l) => l.includes("no writes") && l.includes("1 pending") && l.includes("reinjecting"),
        ),
      ).toBe(true);
    });
  });

  describe("backward compatibility: coalesce=false preserves v1 behavior", () => {
    it("never claims inbound when coalesce=false", () => {
      const { coordinator } = createCoordinator({ coalesce: false });

      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      expect(coordinator.onInboundClaim("ch:1", { content: "msg" })).toBe(false);
    });

    it("suppresses stale no-write responses regardless of pending", () => {
      const { coordinator } = createCoordinator({ coalesce: false });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1");

      // Even if pending existed somehow (it won't via claim, but testing the path)
      const decision = coordinator.getDecision("agent-a", "ch:1", "stale");
      expect(decision.action).toBe("suppress");
    });
  });
});
