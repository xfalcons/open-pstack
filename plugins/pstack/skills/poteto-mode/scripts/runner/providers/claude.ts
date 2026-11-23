import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adapter, isRevision, type Lane, type ParseResult } from "../registry/contract.ts";
import { type AccessMode, UsageError } from "../types.ts";
import {
  effortArgs,
  exactOrSuffixed,
  failedPreflight,
  finiteNumber,
  modelFromUsage,
  normalizedUsage,
  nullableString,
  object,
  type JsonObject,
} from "./shared.ts";

const CONNECTION_VARIABLES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

function connectionEnvironment(source: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const missing = CONNECTION_VARIABLES.filter((key) => source[key] === undefined);
  const configHome = source.CLAUDE_CONFIG_DIR || (source.HOME ? join(source.HOME, ".claude") : null);
  if (missing.length === 0 || configHome === null) return {};

  let contents: string;
  try {
    contents = readFileSync(join(configHome, "settings.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new UsageError("Claude connection settings could not be read");
  }

  let settings: JsonObject | null;
  try {
    settings = object(JSON.parse(contents));
  } catch {
    throw new UsageError("Claude connection settings must be valid JSON");
  }
  if (settings === null) throw new UsageError("Claude connection settings must be an object");
  if (settings.env === undefined) return {};
  const configured = object(settings.env);
  if (configured === null) throw new UsageError("Claude connection settings env must be an object");

  const defaults: Record<string, string> = {};
  for (const key of missing) {
    const value = configured[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new UsageError(`Claude connection settings ${key} must be a string`);
    defaults[key] = value;
  }
  return defaults;
}

function deniedTools(mode: AccessMode): string {
  const always = ["Agent", "Task", "WebSearch", "WebFetch"];
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...always, ...(mode === "read-only" ? readonly : [])].join(",");
}

function tools(mode: AccessMode): string {
  return mode === "read-only"
    ? "Read,Grep,Glob,Bash"
    : "Read,Write,Edit,Grep,Glob,Bash";
}

// Writers run Bash without prompts inside the OS sandbox, which confines writes to the cwd and a
// per-user temp directory. The model cannot opt a command out, and Claude refuses to start when
// the sandbox is unavailable. A linked worktree's shared git directory is otherwise writable, so
// run.ts passes its literal path, which discoverSharedGitDir checked for glob characters.
function permissions(mode: AccessMode, sharedGitDir: string | null): string[] {
  if (mode === "read-only") return ["--permission-mode", "plan"];
  const sandbox = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    ...(sharedGitDir === null ? {} : { filesystem: { denyWrite: [sharedGitDir] } }),
  };
  return ["--permission-mode", "acceptEdits", "--settings", JSON.stringify({ sandbox })];
}

function loggedIn(stdout: string): boolean {
  try {
    return object(JSON.parse(stdout))?.loggedIn === true;
  } catch {
    return false;
  }
}

function matches(lane: Lane, reported: string): boolean {
  const rolling = lane.family?.rolling ?? null;
  return rolling === null ? exactOrSuffixed(lane, reported) : isRevision(rolling, reported);
}

function parse(stdout: string, lane: Lane): ParseResult {
  const malformed = (message: string): ParseResult => ({ kind: "malformed", message });
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return malformed("claude did not emit valid JSON");
  }
  let value: JsonObject | null = null;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const event = object(entry);
      if (event?.type === "result") value = event;
    }
    if (value === null) return malformed("claude result did not contain a terminal event");
  } else {
    value = object(raw);
    if (value === null) return malformed("claude emitted a non-object result");
  }

  if (value.is_error === true) return malformed("claude reported an error result");
  const text = nullableString(value.result);
  if (text === null) return malformed("claude result did not contain final text");

  return {
    kind: "complete",
    text,
    metadata: {
      reportedModel: modelFromUsage(value.modelUsage, lane, matches),
      sessionId: nullableString(value.session_id ?? value.sessionId),
      usage: normalizedUsage(value.usage),
      costUsd: finiteNumber(value.total_cost_usd) ?? null,
    },
  };
}

export const claude = adapter({
  id: "claude",
  executable: "claude",
  effortIn: "flag",
  preflight: {
    argv: () => ["auth", "status", "--json"],
    retryAfterUnauthenticatedMs: null,
    classify: (run) => run.exitCode === 0 && loggedIn(run.stdout)
      ? { kind: "passed", evidence: "authenticated" }
      : failedPreflight(run, "unauthenticated"),
  },
  launch: {
    prompt: "stdin",
    sidecar: null,
    supports: ["read-only", "isolated-write"],
    needsSharedGitDir: (access) => access.mode === "isolated-write",
    argv: (lane, facts) => [
      "-p",
      "--model",
      lane.model,
      ...effortArgs(lane, ["--effort", lane.effort]),
      ...permissions(lane.access.mode, facts.sharedGitDir),
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      tools(lane.access.mode),
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      deniedTools(lane.access.mode),
      "--output-format",
      "json",
    ],
  },
  parse: (run, lane) => parse(run.stdout, lane),
  proof: { report: "required", matches },
  environment: (access, _sidecarDir, source = {}) => ({
    kind: "inherit",
    dropPrefixes: access.mode === "isolated-write" ? ["GIT_"] : [],
    defaults: connectionEnvironment(source),
  }),
  docs: {
    name: "Claude Code CLI",
    hostPrerequisites: [],
    statePaths: ["the Claude config home (`CLAUDE_CONFIG_DIR`, else `~/.claude`)"],
    notes: [
      "For missing process environment values, the runner reads only `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from `env` in the Claude config home's `settings.json`. Both the authentication preflight and the model process receive these values through their environment. The model keeps project-only settings, strict MCP configuration, and the existing tool restrictions; no other user settings are imported. Connection values are never added to argv or the receipt.",
    ],
  },
});
