import type { MemberState } from "../../src/core/types.js";

export type WidgetUiCtx = {
  hasUI?: boolean;
  ui: {
    setWidget: (key: string, lines: string[] | undefined) => void;
  };
};

export type CouncilRow = {
  runId: string;
  prompt: string;
  label?: string;
  members: Array<{ id: string; state: MemberState }>;
};

export function makeCouncilUiState() {
  let sharedCtx: WidgetUiCtx | null = null;
  const councilLabels = new Map<string, string>();
  const mockRows = new Map<string, CouncilRow>();

  function setInteractiveOwner(ctx: WidgetUiCtx): void {
    if (ctx.hasUI) sharedCtx = ctx;
  }

  function renderRows(rows: CouncilRow[]): string[] {
    return rows.map((council) => {
      const label = councilLabels.get(council.runId) ?? council.label ?? council.prompt.slice(0, 40);
      const memberIcons = council.members.map((m) => {
        const icon = m.state === "done" ? "✅" : m.state === "failed" || m.state === "cancelled" ? "❌" : "🔄";
        return `${icon} ${m.id}`;
      }).join("  ");
      return `🏛️ ${label} — ${memberIcons}`;
    });
  }

  function setMockCouncilRow(row: CouncilRow): void {
    mockRows.set(row.runId, row);
    if (row.label) councilLabels.set(row.runId, row.label);
    updateMockWidget();
  }

  function clearMockCouncilRow(runId: string): void {
    mockRows.delete(runId);
    councilLabels.delete(runId);
    updateMockWidget();
  }

  function updateMockWidget(): void {
    if (!sharedCtx) return;
    const rows = [...mockRows.values()];
    if (rows.length === 0) {
      sharedCtx.ui.setWidget("pi-council", undefined);
      return;
    }
    sharedCtx.ui.setWidget("pi-council", renderRows(rows));
  }

  return {
    get sharedCtx() {
      return sharedCtx;
    },
    councilLabels,
    setInteractiveOwner,
    renderRows,
    setMockCouncilRow,
    clearMockCouncilRow,
  };
}
