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

describe("SpeedtrapCoordinator — Absorb + Reinject", () => {
  beforeEach(() => {
    resetSharedState();
  });

  describe("no buffered messages → deliver", () => {
    it("delivers when no new messages arrived during processing", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", "hello", Date.now());
      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      // No new messages arrive
      const decision = coordinator.getDecision("agent-a", "ch:1", "my response");

      expect(decision.action).toBe("deliver");
    });

    it("delivers when no tracked scope exists (conservative)", () => {
      const { coordinator } = createCoordinator();
      expect(coordinator.getDecision("unknown", "ch:1", "resp").action).toBe("deliver");
    });
  });

  describe("absorb → suppress duplicate agent trigger", () => {
    it("suppresses second agent run for same scope", () => {
      const { coordinator } = createCoordinator();

      // First agent starts
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(false);
      // Second trigger for same scope
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(true);
    });

    it("allows agent runs on different channels", () => {
      const { coordinator } = createCoordinator();

      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(false);
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:2")).toBe(false);
    });

    it("allows different agents on same channel", () => {
      const { coordinator } = createCoordinator();

      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(false);
      expect(coordinator.shouldSuppressAgentStart("agent-b", "ch:1")).toBe(false);
    });
  });

  describe("message buffering during processing", () => {
    it("buffers messages when scope is processing", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "new message", Date.now());

      expect(logs.some((l) => l.includes("buffered message (1 total)"))).toBe(true);
    });

    it("buffers multiple messages", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "msg 1", Date.now());
      coordinator.onMessageReceived("ch:1", "msg 2", Date.now());

      expect(logs.some((l) => l.includes("buffered message (2 total)"))).toBe(true);
    });

    it("does not buffer when no scope is processing", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.onMessageReceived("ch:1", "hello", Date.now());

      expect(logs.some((l) => l.includes("no active scope to buffer"))).toBe(true);
    });
  });

  describe("reinject when buffered messages exist", () => {
    it("reinjects when messages arrived during processing", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "follow-up question", Date.now());

      const decision = coordinator.getDecision("agent-a", "ch:1", "my draft response");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("follow-up question");
        expect(decision.context).toContain("my draft response");
        expect(decision.context).toContain("NEW MESSAGES ARRIVED");
      }
    });

    it("includes all buffered messages in reinject context", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "msg one", Date.now());
      coordinator.onMessageReceived("ch:1", "msg two", Date.now());

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("msg one");
        expect(decision.context).toContain("msg two");
      }
    });

    it("includes write tool info in reinject context", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onMessageReceived("ch:1", "new msg", Date.now());

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("write_file");
      }
    });

    it("does not include tool info when only read tools used", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onMessageReceived("ch:1", "new msg", Date.now());

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");

      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).not.toContain("write operations");
      }
    });
  });

  describe("reinject budget", () => {
    it("delivers after maxReinjects is reached", () => {
      const { coordinator } = createCoordinator({ maxReinjects: 2 });

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "msg 1", Date.now());

      expect(coordinator.getDecision("agent-a", "ch:1", "draft-1").action).toBe("reinject");
      // Buffer another message for the second reinject
      coordinator.onMessageReceived("ch:1", "msg 2", Date.now());
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-2").action).toBe("reinject");

      // Budget exhausted — deliver even if more messages come
      coordinator.onMessageReceived("ch:1", "msg 3", Date.now());
      expect(coordinator.getDecision("agent-a", "ch:1", "draft-3").action).toBe("deliver");
    });
  });

  describe("multi-channel isolation", () => {
    it("buffers only affect the correct channel scope", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.shouldSuppressAgentStart("agent-a", "ch:2");

      // Message only on ch:1
      coordinator.onMessageReceived("ch:1", "new msg", Date.now());

      expect(coordinator.getDecision("agent-a", "ch:1", "draft").action).toBe("reinject");
      expect(coordinator.getDecision("agent-a", "ch:2", "draft").action).toBe("deliver");
    });
  });

  describe("scope cleanup", () => {
    it("cleans up scope after deliver", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.getDecision("agent-a", "ch:1", "draft");

      // Scope cleaned up — new agent can start
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(false);
    });

    it("keeps scope alive during reinject cycle", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onMessageReceived("ch:1", "msg", Date.now());

      // Reinject — scope stays alive
      expect(coordinator.getDecision("agent-a", "ch:1", "draft").action).toBe("reinject");

      // Should still suppress new runs for this scope during reinject
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(true);
    });
  });

  describe("tool call tracking with agentId fallback", () => {
    it("tracks tool calls when channelKey is not provided", () => {
      const { coordinator } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      // Tool call without channelKey — falls back to agentId lookup
      coordinator.onToolCall("agent-a", undefined, "bash");
      coordinator.onMessageReceived("ch:1", "msg", Date.now());

      const decision = coordinator.getDecision("agent-a", "ch:1", "draft");
      expect(decision.action).toBe("reinject");
      if (decision.action === "reinject") {
        expect(decision.context).toContain("bash");
      }
    });
  });

  describe("end-to-end absorb + reinject flow", () => {
    it("full flow: absorb trigger, buffer message, reinject, then deliver", () => {
      const { coordinator } = createCoordinator();

      // 1. Message A arrives, agent starts
      coordinator.onMessageReceived("ch:1", "hello", Date.now());
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(false);

      // 2. Message B arrives while processing — gets buffered
      coordinator.onMessageReceived("ch:1", "also, can you...", Date.now());

      // 3. Message B's agent trigger is suppressed
      expect(coordinator.shouldSuppressAgentStart("agent-a", "ch:1")).toBe(true);

      // 4. Agent finishes A — sees buffered messages — reinjects
      const decision1 = coordinator.getDecision("agent-a", "ch:1", "Here's my response to hello");
      expect(decision1.action).toBe("reinject");
      if (decision1.action === "reinject") {
        expect(decision1.context).toContain("also, can you...");
        expect(decision1.context).toContain("Here's my response to hello");
      }

      // 5. No more messages — deliver
      const decision2 = coordinator.getDecision("agent-a", "ch:1", "Updated response");
      expect(decision2.action).toBe("deliver");
    });
  });

  describe("debug logging", () => {
    it("logs key decisions", () => {
      const { coordinator, logs } = createCoordinator();

      coordinator.shouldSuppressAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onMessageReceived("ch:1", "msg", Date.now());
      coordinator.getDecision("agent-a", "ch:1", "resp");

      expect(logs.some((l) => l.includes("agent start, marked as processing"))).toBe(true);
      expect(logs.some((l) => l.includes("memory_search (read)"))).toBe(true);
      expect(logs.some((l) => l.includes("buffered message"))).toBe(true);
      expect(logs.some((l) => l.includes("reinjecting"))).toBe(true);
    });
  });
});
