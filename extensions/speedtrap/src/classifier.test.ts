import { describe, expect, it } from "vitest";
import { isWriteTool } from "./classifier.js";

describe("isWriteTool", () => {
  describe("known read-only tools", () => {
    const readOnlyTools = [
      "memory_search",
      "web_search",
      "web_fetch",
      "file_read",
      "read_file",
      "list_files",
      "search_files",
      "glob",
      "grep",
      "cat",
      "ls",
      "pwd",
    ];

    for (const tool of readOnlyTools) {
      it(`classifies ${tool} as read-only`, () => {
        expect(isWriteTool(tool, true)).toBe(false);
      });
    }
  });

  describe("heuristic read prefixes", () => {
    const readPrefixTools = [
      "read_config",
      "search_database",
      "get_user",
      "list_items",
      "find_matches",
      "fetch_data",
      "query_logs",
      "lookup_address",
      "check_status",
      "view_document",
      "show_results",
      "describe_table",
      "inspect_element",
    ];

    for (const tool of readPrefixTools) {
      it(`classifies ${tool} as read-only via prefix heuristic`, () => {
        expect(isWriteTool(tool, true)).toBe(false);
      });
    }
  });

  describe("unknown tools with assumeUnknownAreWrites=true", () => {
    it("classifies unknown tool as write", () => {
      expect(isWriteTool("deploy_service", true)).toBe(true);
    });

    it("classifies bash as write", () => {
      expect(isWriteTool("bash", true)).toBe(true);
    });
  });

  describe("unknown tools with assumeUnknownAreWrites=false", () => {
    it("classifies unknown tool as read", () => {
      expect(isWriteTool("deploy_service", false)).toBe(false);
    });
  });

  describe("normalization", () => {
    it("handles hyphenated tool names", () => {
      expect(isWriteTool("web-search", true)).toBe(false);
    });

    it("handles uppercase tool names", () => {
      expect(isWriteTool("MEMORY_SEARCH", true)).toBe(false);
    });

    it("handles mixed case with hyphens", () => {
      expect(isWriteTool("Web-Fetch", true)).toBe(false);
    });
  });
});
