import { describe, expect, it } from "vitest";
import { SpeedtrapV2Coordinator } from "./coordinator.js";
import type { SpeedtrapV2Config } from "./types.js";

function createCoordinator(
  overrides: Partial<SpeedtrapV2Config> = {},
): { coordinator: SpeedtrapV2Coordinator; logs: string[] } {
  const logs: string[] = [];
  const config: SpeedtrapV2Config = {
    assumeUnknownToolsAreWrites: true,
    debug: true,
    ...overrides,
  };
  const coordinator = new SpeedtrapV2Coordinator(config, (msg) => logs.push(msg));
  return { coordinator, logs };
}

describe("SpeedtrapV2Coordinator", () => {
  describe("channel unchanged → deliver", () => {
    it("delivers when no new messages arrived", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      // No new messages arrive
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(false);
    });
  });

  describe("channel moved, no writes → discard", () => {
    it("suppresses when channel moved and agent had no write side effects", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      // New message arrives while agent is thinking
      coordinator.onMessageReceived("ch:1", 2000);
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(true);
    });

    it("suppresses when agent only used read-only tools", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onToolCall("agent-a", "ch:1", "web_search");
      coordinator.onToolCall("agent-a", "ch:1", "file_read");
      coordinator.onMessageReceived("ch:1", 2000);
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(true);
    });
  });

  describe("channel moved, has writes → deliver (forced)", () => {
    it("delivers when agent had write side effects despite channel moving", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "write_file");
      coordinator.onMessageReceived("ch:1", 2000);
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(false);
    });

    it("delivers when unknown tool used with assumeUnknownToolsAreWrites=true", () => {
      const { coordinator } = createCoordinator({ assumeUnknownToolsAreWrites: true });

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "some_custom_tool");
      coordinator.onMessageReceived("ch:1", 2000);
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(false);
    });
  });

  describe("assumeUnknownToolsAreWrites=false", () => {
    it("suppresses when unknown tool used with assumeUnknownToolsAreWrites=false", () => {
      const { coordinator } = createCoordinator({ assumeUnknownToolsAreWrites: false });

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "some_custom_tool");
      coordinator.onMessageReceived("ch:1", 2000);
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");

      expect(suppress).toBe(true);
    });
  });

  describe("thundering herd scenario", () => {
    it("fastest agent delivers, slower agents get discarded", () => {
      const { coordinator } = createCoordinator();

      // All 3 agents see the same message
      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:1");
      coordinator.onAgentStart("agent-c", "ch:1");

      // Agent A finishes first — channel hasn't moved
      const suppressA = coordinator.shouldSuppress("agent-a", "ch:1");
      expect(suppressA).toBe(false); // delivers

      // Agent A's response appears as a new message on the channel
      coordinator.onMessageReceived("ch:1", 2000);

      // Agent B finishes — channel moved
      const suppressB = coordinator.shouldSuppress("agent-b", "ch:1");
      expect(suppressB).toBe(true); // discarded

      // Agent C finishes — channel still moved
      const suppressC = coordinator.shouldSuppress("agent-c", "ch:1");
      expect(suppressC).toBe(true); // discarded
    });
  });

  describe("cascade self-extinguishing", () => {
    it("cascade-triggered runs get discarded as channel keeps moving", () => {
      const { coordinator } = createCoordinator();

      // Original user message
      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");

      // Agent A finishes + delivers
      const suppressA = coordinator.shouldSuppress("agent-a", "ch:1");
      expect(suppressA).toBe(false);

      // Agent A's response triggers agent B (cascade)
      coordinator.onMessageReceived("ch:1", 2000);
      coordinator.onAgentStart("agent-b", "ch:1");

      // Agent B's response appears
      coordinator.onMessageReceived("ch:1", 3000);

      // Meanwhile agent B finishes — channel moved
      const suppressB = coordinator.shouldSuppress("agent-b", "ch:1");
      expect(suppressB).toBe(true); // cascade extinguished
    });
  });

  describe("no tracked run → deliver (conservative)", () => {
    it("delivers when no run state exists for the agent", () => {
      const { coordinator } = createCoordinator();

      const suppress = coordinator.shouldSuppress("unknown-agent", "ch:1");
      expect(suppress).toBe(false);
    });
  });

  describe("multi-channel isolation", () => {
    it("channel movement on one channel does not affect another", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onMessageReceived("ch:2", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onAgentStart("agent-b", "ch:2");

      // Only ch:1 moves
      coordinator.onMessageReceived("ch:1", 2000);

      const suppressA = coordinator.shouldSuppress("agent-a", "ch:1");
      const suppressB = coordinator.shouldSuppress("agent-b", "ch:2");

      expect(suppressA).toBe(true); // ch:1 moved
      expect(suppressB).toBe(false); // ch:2 unchanged
    });
  });

  describe("run state cleanup", () => {
    it("cleans up run state after shouldSuppress", () => {
      const { coordinator } = createCoordinator();

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");

      // First call cleans up
      coordinator.shouldSuppress("agent-a", "ch:1");

      // Second call has no state → conservative deliver
      const suppress = coordinator.shouldSuppress("agent-a", "ch:1");
      expect(suppress).toBe(false);
    });
  });

  describe("debug logging", () => {
    it("logs all decisions when debug is true", () => {
      const { coordinator, logs } = createCoordinator({ debug: true });

      coordinator.onMessageReceived("ch:1", 1000);
      coordinator.onAgentStart("agent-a", "ch:1");
      coordinator.onToolCall("agent-a", "ch:1", "memory_search");
      coordinator.onMessageReceived("ch:1", 2000);
      coordinator.shouldSuppress("agent-a", "ch:1");

      expect(logs).toContain("Channel ch:1: message received, timestamp updated");
      expect(logs).toContain("Agent agent-a started on ch:1, snapshot timestamp=1000");
      expect(logs).toContain("Agent agent-a tool call: memory_search (classified as read)");
      expect(logs.some((l) => l.includes("channel moved, no writes → discarding"))).toBe(true);
    });
  });
});
