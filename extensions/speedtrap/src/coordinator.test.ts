import { beforeEach, describe, expect, it } from "vitest";
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
    ...overrides,
  };
  const coordinator = new SpeedtrapCoordinator(config, (msg) => logs.push(msg));
  return { coordinator, logs };
}

describe("SpeedtrapCoordinator", () => {
  beforeEach(() => {
    resetSharedState();
  });

  describe("channel unchanged → deliver", () => {
    it("delivers when no new messages arrived after agent start", () => {
      const { coordinator } = createCoordinator();

      // Message arrives, agent starts, no new messages
      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");
      // No new message_received after agent start
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("deliver");
    });

    it("delivers when agent starts before any messages on channel", () => {
      const { coordinator } = createCoordinator();

      // Agent starts on a channel with no history
      coordinator.onAgentStart("agent-a", "ch:1");
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("deliver");
    });
  });

  describe("channel moved, no writes → suppress", () => {
    it("suppresses when channel moved and agent had no write side effects", () => {
      const { coordinator } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      // Message arrives after agent started
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
      // Channel moves after agent started
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

      // Triggering message arrives
      coordinator.onMessageReceived("ch:1");

      // All 3 agents start processing (snapshot same count)
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");
      coordinator.onAgentStart("agent-c", "ch:1");

      // Agent A finishes first — no new messages on channel
      expect(coordinator.getDecision("agent-a", "ch:1", "resp-a").action).toBe("deliver");

      // Agent A's response appears as a new message on the channel
      coordinator.onMessageReceived("ch:1");

      // Agent B finishes — channel moved
      expect(coordinator.getDecision("agent-b", "ch:1", "resp-b").action).toBe("suppress");

      // Agent C finishes — channel still moved
      expect(coordinator.getDecision("agent-c", "ch:1", "resp-c").action).toBe("suppress");
    });
  });

  describe("cascade self-extinguishing", () => {
    it("cascade-triggered runs get discarded as channel keeps moving", () => {
      const { coordinator } = createCoordinator();

      // Initial message
      coordinator.onMessageReceived("ch:1");

      // Agent A starts
      coordinator.onAgentStart("agent-a", "ch:1");

      // Agent A finishes + delivers (no channel movement since snapshot)
      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("deliver");

      // Agent A's response triggers agent B (cascade) — new message on channel
      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");

      // Another message appears
      coordinator.onMessageReceived("ch:1");

      // Agent B finishes — channel moved since its snapshot
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

      // Only ch:1 gets a new message
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

      // Only ch:1 moves
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

      // First call cleans up
      coordinator.getDecision("agent-a", "ch:1", "resp");

      // Second call has no state → conservative deliver
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
      expect(logs.some((l) => l.includes("channel moved, no writes → discarding"))).toBe(true);
    });

    it("logs reinject decisions", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");
      coordinator.getDecision("agent-a", "ch:1", "resp");

      expect(logs.some((l) => l.includes("channel moved, has writes → reinjecting (1/3)"))).toBe(
        true,
      );
    });

    it("logs message count on receive", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onMessageReceived("ch:1");
      coordinator.onMessageReceived("ch:1");

      expect(logs.some((l) => l.includes("count=1"))).toBe(true);
      expect(logs.some((l) => l.includes("count=2"))).toBe(true);
    });
  });

  describe("reinject budget exhaustion", () => {
    it("delivers after maxReinjects is reached", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 2 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      // First two calls reinject
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");

      // Third call: budget exhausted, forced delivery
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-3").action).toBe("deliver");
    });

    it("cleans up run state after budget exhaustion", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 1 });

      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "bash");
      coordinator.onMessageReceived("ch:1");

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("deliver");

      // State cleaned up — falls back to conservative deliver
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

      // Reinject keeps state
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      // State still there for next decision
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");
    });
  });

  describe("triggering message does not cause false positive", () => {
    it("message before agent start does not count as channel moved", () => {
      const { coordinator } = createCoordinator();

      // The triggering message arrives and the agent starts
      // (message_received fires before before_agent_start)
      coordinator.onMessageReceived("ch:1");
      coordinator.onAgentStart("agent-a", "ch:1");

      // Agent finishes — the triggering message was snapshotted, not "new"
      expect(coordinator.getDecision("agent-a", "ch:1", "resp").action).toBe("deliver");
    });
  });
});
