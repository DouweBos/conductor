import {
  Button,
  EmptyState,
  Icon,
  Matrix,
  Select,
  StatusPill,
  TextField,
  type MatrixGroup,
  type MatrixRow,
} from "@conductor/studio-ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { casesMatrix, exportCases, pickCaseExportPath, runFlow } from "../../lib/ipc";
import { useRoute } from "../../lib/router";
import type { CaseMatrix, CaseResult, TestCase } from "../../lib/types";
import { devicesFor } from "../../lib/platforms";
import { refreshDevices, useDevices, useSelectedDeviceId } from "../../stores/deviceStore";
import { useProject } from "../../stores/projectStore";
import { getRunOptions } from "../../stores/runOptionsStore";
import { beginRun, useRunId, useRunStatus } from "../../stores/runStore";
import { CaseDetail, CaseEditor, ids } from "./CaseDetail";
import { CaseDeviceStream } from "./CaseDeviceStream";
import { CaseRunStatus } from "./CaseRunStatus";
import { ImportDialog } from "./ImportDialog";
import { PlansPanel } from "./PlansPanel";
import { RunWizard } from "./RunWizard";
import styles from "./CasesView.module.css";

const FALLBACK_DIMENSIONS = ["platform", "vertical", "product"];

const SOURCE_LABEL: Record<CaseResult["source"], string> = {
  run: "flow",
  manual: "by hand",
  report: "agent",
  ci: "CI",
};

/** The flow covering a case on one column — per-platform first, then the lone `flow`. */
function flowFor(c: TestCase, column?: string): string | undefined {
  if (column && c.flows?.[column]) return c.flows[column];
  return c.flows ? (column ? undefined : Object.values(c.flows)[0]) : c.flow;
}

/**
 * One cell of a 150-row matrix, so it is built for scanning down a column, not
 * for looking at on its own: left-aligned, one line, fixed width, and the state
 * carried by a dot the eye can follow.
 *
 *   solid dot   — a verdict; the word takes the verdict's colour
 *   hollow ring — automated, nothing has run it yet
 *   no dot      — no automation here, so a person has to walk it
 *   empty cell  — the case doesn't apply to this platform
 *
 * The ▶ only appears on the hovered row: 150 permanent buttons is a texture,
 * not an affordance.
 */
function CaseCell({
  testCase: c,
  column,
  onRun,
}: {
  testCase: TestCase;
  column: string;
  onRun: (flow: string, platform?: string) => void;
}) {
  const flow = flowFor(c, column);
  // Newest result covering this column: scoped to it, or case-level (a manual
  // verdict, or a case implemented by a single flow).
  const result = (c.results ?? []).find((r) => r.column === column || !r.column);

  let state: "verdict" | "pending" | "manual";
  let label: string;
  let tone: string;
  let title: string;

  if (result) {
    state = "verdict";
    label = result.verdict;
    tone = result.verdict;
    title = `${result.verdict} — ${SOURCE_LABEL[result.source]}, ${new Date(result.at).toLocaleString()}${
      result.note ? `\n${result.note}` : ""
    }`;
  } else if (flow) {
    state = "pending";
    label = "not run";
    tone = "none";
    title = `${flow} — never run here`;
  } else {
    state = "manual";
    label = "manual";
    tone = "none";
    title = "No flow here — verify by hand, or write one from the case's steps";
  }

  return (
    <span className={styles.cell} data-state={state} data-tone={tone} title={title}>
      {flow ? (
        // The status dot is the button: hovering the row turns it into a play
        // triangle rather than growing a second control beside it.
        <button
          type="button"
          className={styles.indicator}
          aria-label={`Run ${flow}`}
          title={`Run ${flow}`}
          onClick={(e) => {
            e.stopPropagation();
            onRun(flow, column);
          }}
        >
          <span className={styles.dot} />
          <Icon name="play" size={11} className={styles.playIcon} />
        </button>
      ) : state === "manual" ? null : (
        <span className={styles.dot} />
      )}
      <span className={styles.cellLabel}>{label}</span>
    </span>
  );
}

export function CasesView() {
  const [dimension, setDimension] = useState("platform");
  const [matrix, setMatrix] = useState<CaseMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<"case" | "plans" | "new" | "wizard">("case");
  const [importing, setImporting] = useState(false);
  // Survives leaving the screen: a run you started is still going, and coming
  // back to a collapsed rail reads as "the run vanished".
  // Which device each platform column runs on; "" means auto-pick.
  const [columnDevice, setColumnDevice] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("cases.columnDevice") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem("cases.columnDevice", JSON.stringify(columnDevice));
  }, [columnDevice]);

  const [showDevice, setShowDevice] = useState(
    () => localStorage.getItem("cases.device") === "1",
  );
  useEffect(() => {
    localStorage.setItem("cases.device", showDevice ? "1" : "0");
  }, [showDevice]);
  const [groupBy, setGroupBy] = useState("area");
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem("cases.collapsed") ?? "[]") as string[]),
  );

  useEffect(() => {
    localStorage.setItem("cases.collapsed", JSON.stringify([...collapsed]));
  }, [collapsed]);
  const projectRoot = useProject()?.root ?? null;
  const deviceId = useSelectedDeviceId();
  const devices = useDevices();

  // The column pickers need the device list even before the rail is opened.
  useEffect(() => {
    void refreshDevices();
  }, [projectRoot]);
  const activeRunId = useRunId();
  const activeRunStatus = useRunStatus();

  // Whether the run started here or is still going when you come back, the rail
  // belongs open.
  useEffect(() => {
    if (activeRunId && activeRunStatus === "running") setShowDevice(true);
  }, [activeRunId, activeRunStatus]);

  const refresh = useCallback(() => {
    casesMatrix(dimension)
      .then((m) => {
        setMatrix(m);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [dimension, projectRoot]);

  useEffect(refresh, [refresh]);
  // Results land from anywhere — the ▶ button, a plan, a flow run in the
  // workbench, the agent over MCP — so the matrix listens rather than polls.
  useIpcEvent<unknown>("cases:result-recorded", refresh);
  useIpcEvent<unknown>("plans:run-updated", refresh);

  /** Run one case's flow, then follow it into the workbench where the console lives. */
  const run = async (flow: string, platform?: string) => {
    try {
      setNotice(null);
      // The column's device wins: it's the explicit answer to "tvOS or Android
      // TV", which the platform alone can't give.
      const { runId, deviceId: ranOn } = await runFlow(
        flow,
        (platform ? columnDevice[platform] : "") || deviceId || undefined,
        getRunOptions(),
        platform,
      );
      beginRun(runId, flow, ranOn);
      // Stay on the matrix: the device rail shows the run, so a case never
      // hands you off to the file behind it.
      setShowDevice(true);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const exportCsv = async () => {
    try {
      const file = await pickCaseExportPath();
      if (!file) return;
      setNotice(`Exported ${await exportCases(file)} cases to ${file}`);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const cases = matrix?.cases ?? [];

  // Every tag dimension the cases actually use — the columns picker and the
  // filter row are both driven by the data, not by a fixed list.
  const dimensions = useMemo(() => {
    const found = new Set(cases.flatMap((c) => Object.keys(c.tags)));
    for (const d of FALLBACK_DIMENSIONS) found.add(d);
    return [...found].sort();
  }, [cases]);

  // Fall back to a flat list when the chosen grouping isn't in this project's
  // tags — "area" is a good default, not a guarantee.
  useEffect(() => {
    if (groupBy !== "none" && cases.length && !dimensions.includes(groupBy)) setGroupBy("none");
  }, [cases.length, dimensions, groupBy]);

  const filterable = useMemo(
    () =>
      dimensions
        .filter((d) => d !== dimension)
        .map((d) => ({ dimension: d, values: [...new Set(cases.flatMap((c) => c.tags[d] ?? []))].sort() }))
        .filter((f) => f.values.length > 1),
    [dimensions, dimension, cases],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases.filter((c) => {
      for (const [dim, value] of Object.entries(filters)) {
        if (value && !(c.tags[dim] ?? []).includes(value)) return false;
      }
      if (!q) return true;
      const haystack = [
        c.id,
        ...(c.altIds ?? []),
        c.title,
        c.userStory ?? "",
        c.owner ?? "",
        ...Object.values(c.flows ?? {}),
        c.flow ?? "",
      ];
      return haystack.some((s) => s.toLowerCase().includes(q));
    });
  }, [cases, filters, query]);

  const selected = useMemo(() => cases.find((c) => c.id === selectedId) ?? null, [cases, selectedId]);

  const toRow = useCallback(
    (c: TestCase, columnsOf: string[]): MatrixRow => {
      const values = c.tags[dimension] ?? [];
      const cells: Record<string, React.ReactNode> = {};
      for (const col of columnsOf) {
        if (!values.includes(col)) continue;
        cells[col] = (
          <CaseCell testCase={c} column={col} onRun={run} />
        );
      }
      const breadcrumb =
        groupBy === "area"
          ? c.tags.feature?.[0]
          : [c.tags.area?.[0], c.tags.feature?.[0]].filter(Boolean).join(" › ");
      return {
        id: c.id,
        label: c.title,
        sublabel: [ids(c), breadcrumb, c.owner].filter(Boolean).join("  ·  "),
        cells,
      };
    },
    [dimension, groupBy, deviceId],
  );

  const rows: MatrixRow[] = useMemo(
    () => (matrix ? visible.map((c) => toRow(c, matrix.columns)) : []),
    [matrix, visible, toRow],
  );

  /**
   * 150 rows is a list, not a table you can read. Bands by a tag dimension —
   * area by default, which is how a matrix is written — turn it back into
   * something with a table of contents, each carrying its own coverage.
   */
  const groups: MatrixGroup[] | undefined = useMemo(() => {
    if (!matrix || groupBy === "none") return undefined;
    const buckets = new Map<string, TestCase[]>();
    for (const c of visible) {
      // A case with several values for the dimension belongs to the first —
      // duplicating it across bands would double every count on the screen.
      const key = c.tags[groupBy]?.[0] ?? "Ungrouped";
      buckets.set(key, [...(buckets.get(key) ?? []), c]);
    }
    const names = [...buckets.keys()].sort((a, b) =>
      a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b),
    );
    return names.map((name) => {
      const scoped = buckets.get(name)!;
      const automated = scoped.filter((c) => c.flow || Object.keys(c.flows ?? {}).length).length;
      const failing = scoped.filter((c) => c.lastResult?.verdict === "failed").length;
      return {
        id: name,
        label: name,
        collapsed: collapsed.has(name),
        meta: [
          `${automated}/${scoped.length} automated`,
          failing ? `${failing} failing` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        rows: [...scoped]
          .sort(
            (a, b) =>
              (a.tags.feature?.[0] ?? "").localeCompare(b.tags.feature?.[0] ?? "") ||
              a.id.localeCompare(b.id),
          )
          .map((c) => toRow(c, matrix.columns)),
      };
    });
  }, [matrix, visible, groupBy, collapsed, toRow]);

  /**
   * Each column is a platform, so the column header is where you say which
   * device it runs on — the only place tvOS and Android TV are distinguishable,
   * since both answer to `tv`. "Auto" keeps the old behaviour: first booted
   * device of the right kind.
   */
  const columns = useMemo(
    () =>
      (matrix?.columns ?? []).map((c) => ({
        id: c,
        width: 190,
        label: (
          <span className={styles.colHeader}>
            <span>{c}</span>
            <Select
              className={styles.colDevice}
              value={columnDevice[c] ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                setColumnDevice((prev) => ({ ...prev, [c]: e.target.value }))
              }
              options={[
                { value: "", label: "Auto" },
                ...devicesFor(devices, c).map((d) => ({
                  value: d.id,
                  label: `${d.name}${d.state === "booted" ? "" : " · off"}`,
                })),
              ]}
            />
          </span>
        ),
      })),
    [matrix, devices, columnDevice],
  );

  // Coverage per column: how many of the cases tagged for it have a flow there.
  const coverage = useMemo(
    () =>
      (matrix?.columns ?? []).map((col) => {
        const scoped = cases.filter((c) => (c.tags[matrix!.dimension] ?? []).includes(col));
        return { col, covered: scoped.filter((c) => flowFor(c, col)).length, total: scoped.length };
      }),
    [matrix, cases],
  );

  const executed = cases.filter((c) => c.lastResult).length;

  const openCase = (id: string) => {
    setSelectedId(id);
    setPane("case");
  };

  // `#/cases/<id>` — how a report links back to the case it verified.
  const routeCaseId = useRoute().caseId;
  useEffect(() => {
    if (routeCaseId) openCase(routeCaseId);
  }, [routeCaseId]);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Test cases</h1>
          <p className={styles.subtitle}>
            The spec, what implements it, and every time it was verified — by a flow, a person,
            the agent or CI.
          </p>
        </div>
        <div className={styles.controls}>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setPane("new")}>
            New case
          </Button>
          <Button size="sm" variant="ghost" icon="folder" onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button size="sm" variant="ghost" icon="file" onClick={() => void exportCsv()}>
            Export
          </Button>
          <Button size="sm" variant="ghost" icon="matrix" onClick={() => setPane("plans")}>
            Plans
          </Button>
          <Button size="sm" variant="secondary" icon="play" onClick={() => setPane("wizard")}>
            Run manually
          </Button>
          <Button
            size="sm"
            variant={showDevice ? "secondary" : "ghost"}
            icon="device"
            onClick={() => setShowDevice((v) => !v)}
          >
            Device
          </Button>
          <span className={styles.controlLabel}>Group:</span>
          <Select
            options={[
              { value: "none", label: "flat list" },
              ...dimensions.filter((d) => d !== dimension).map((d) => ({ value: d, label: d })),
            ]}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
          />
          <span className={styles.controlLabel}>Columns:</span>
          <Select
            options={dimensions.map((d) => ({ value: d, label: d }))}
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          />
          <Button size="sm" variant="ghost" icon="refresh" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </header>

      <div className={styles.filters}>
        <TextField
          icon="search"
          placeholder="Search cases, ids, owners, flows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filterable.map(({ dimension: dim, values }) => (
          <Select
            key={dim}
            value={filters[dim] ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, [dim]: e.target.value }))}
            options={[
              { value: "", label: `All ${dim}` },
              ...values.map((v) => ({ value: v, label: v })),
            ]}
          />
        ))}
        <span className={styles.count}>
          {visible.length === cases.length ? `${cases.length} cases` : `${visible.length} of ${cases.length}`}
        </span>
        <StatusPill tone={executed ? "info" : "neutral"}>{executed}/{cases.length} ever executed</StatusPill>
        {coverage.map(({ col, covered, total }) => (
          <StatusPill key={col} tone={covered ? "info" : "neutral"}>
            {col}: {covered}/{total} automated
          </StatusPill>
        ))}
        {notice ? <StatusPill tone="warning">{notice}</StatusPill> : null}
        {groups && groups.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            icon={collapsed.size ? "chevronDown" : "chevronRight"}
            onClick={() =>
              setCollapsed(collapsed.size ? new Set() : new Set(groups.map((g) => g.id)))
            }
          >
            {collapsed.size ? "Expand all" : "Collapse all"}
          </Button>
        ) : null}
        {cases.length ? (
          <span className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.dot} data-legend="verdict" /> ran
            </span>
            <span className={styles.legendItem}>
              <span className={styles.dot} data-legend="pending" /> not run yet
            </span>
            <span className={styles.legendItem}>manual — no flow</span>
          </span>
        ) : null}
      </div>

      <div className={styles.body}>
        <div className={styles.matrix}>
          {error ? (
            <EmptyState icon="alert" title="Couldn't load cases" description={error} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="matrix"
              title={cases.length ? "No case matches these filters" : "No test cases yet"}
              description={
                cases.length
                  ? "Clear the search or filters to see the rest."
                  : "Create one, or import a CSV from the tool you're moving off. Cases are YAML files under ~/.conductor/studio/cases/, kept out of the repo under test."
              }
            />
          ) : (
            <Matrix
              columns={columns}
              rows={groups ? undefined : rows}
              groups={groups}
              onRowClick={openCase}
              onToggleGroup={(id) =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          )}
        </div>

        {pane === "wizard" ? (
          <RunWizard
            cases={visible}
            onClose={() => setPane("case")}
            onRecorded={refresh}
            onRunStarted={() => setShowDevice(true)}
          />
        ) : pane === "plans" ? (
          <PlansPanel
            currentFilter={Object.fromEntries(
              Object.entries(filters)
                .filter(([, v]) => v)
                .map(([dim, v]) => [dim, [v]]),
            )}
            onClose={() => setPane("case")}
          />
        ) : pane === "new" ? (
          <CaseEditor
            testCase={null}
            onCancel={() => setPane("case")}
            onSaved={(saved) => {
              setPane("case");
              setSelectedId(saved.id);
              refresh();
            }}
          />
        ) : selected ? (
          <CaseDetail
            testCase={selected}
            onClose={() => setSelectedId(null)}
            onRun={run}
            onChanged={refresh}
          />
        ) : null}
        {showDevice ? (
          <aside className={styles.deviceRail}>
            <CaseRunStatus />
            <CaseDeviceStream />
          </aside>
        ) : null}
      </div>

      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(created, updated) => {
            setImporting(false);
            setNotice(`Imported ${created} new and updated ${updated} cases`);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
