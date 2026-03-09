/**
 * Speedtrap — Tool Side-Effect Classifier
 *
 * Determines whether a tool call is read-only (safe to discard) or has
 * write side effects (must force delivery). Conservative default: unknown
 * tools are treated as writes.
 */

/**
 * Tools known to be read-only. These have no side effects — their results
 * are consumed by the agent but don't change external state.
 */
const READ_ONLY_TOOLS = new Set([
  "memory_search",
  "web_search",
  "web_fetch",
  "file_read",
  "read_file",
  "list_files",
  "list_directory",
  "search_files",
  "search_code",
  "get_file",
  "glob",
  "grep",
  "find",
  "cat",
  "head",
  "tail",
  "ls",
  "pwd",
  "which",
  "whoami",
  "date",
  "calendar_list",
  "calendar_get",
  "get_weather",
  "get_time",
  "knowledge_search",
  "vector_search",
  "embedding_search",
  "semantic_search",
  "retrieve",
  "lookup",
]);

/**
 * Classify a tool call as read-only or write.
 *
 * @param toolName - The tool name from the hook event
 * @param assumeUnknownAreWrites - If true, unknown tools are treated as writes
 * @returns true if the tool has write side effects
 */
export function isWriteTool(toolName: string, assumeUnknownAreWrites: boolean): boolean {
  const normalized = toolName.toLowerCase().replace(/[-\s]/g, "_");

  if (READ_ONLY_TOOLS.has(normalized)) {
    return false;
  }

  // Heuristic: tools with read/search/get/list/find/fetch prefixes are reads
  if (
    /^(read|search|get|list|find|fetch|query|lookup|check|view|show|describe|inspect)_/.test(
      normalized,
    )
  ) {
    return false;
  }

  // Everything else: use the configured default
  return assumeUnknownAreWrites;
}
