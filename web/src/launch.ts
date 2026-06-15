import type { PaneInfo } from "./types";

export type SplitDirection = "right" | "down";
export type LaunchKind = "shell" | "codex" | "claude" | "pi";

export type LaunchSpec = {
  kind: LaunchKind;
  title: string;
};

export type LaunchTarget =
  | { mode: "tab"; workspaceId: string }
  | { mode: "split"; pane: PaneInfo; direction: SplitDirection };

export const LAUNCH_OPTIONS: { kind: LaunchKind; label: string }[] = [
  { kind: "shell", label: "Shell" },
  { kind: "codex", label: "Codex" },
  { kind: "claude", label: "Claude" },
  { kind: "pi", label: "pi" },
];

const AGENT_ARGV: Record<Exclude<LaunchKind, "shell">, string[]> = {
  codex: ["codex"],
  claude: ["claude"],
  pi: ["pi"],
};

export function launchLabel(kind: LaunchKind) {
  return LAUNCH_OPTIONS.find((option) => option.kind === kind)?.label ?? "Shell";
}

export function agentArgv(kind: LaunchKind): string[] {
  if (kind === "shell") {
    throw new Error("shell does not have an agent argv");
  }
  return AGENT_ARGV[kind];
}

export function resolveLaunchSpec(spec: LaunchSpec, existingPanes: readonly PaneInfo[]): LaunchSpec {
  if (spec.kind === "shell" || spec.title !== launchLabel(spec.kind)) {
    return spec;
  }

  const used = new Set(
    existingPanes
      .flatMap((pane) => [pane.label, pane.display_agent, pane.agent, pane.title])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
  if (!used.has(spec.title)) {
    return spec;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${spec.title} ${index}`;
    if (!used.has(candidate)) {
      return { ...spec, title: candidate };
    }
  }

  return { ...spec, title: `${spec.title} ${Date.now()}` };
}
