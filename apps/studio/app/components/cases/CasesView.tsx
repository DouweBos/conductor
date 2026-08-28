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
import {
  casesMatrix,
  qaseProjects as fetchQaseProjects,
  refreshCases,
  runFlow,
} from "../../lib/ipc";
import { closeCase, selectCase, useRoute } from "../../lib/router";
import type { Case, CaseMatrix, QaseProject } from "../../lib/types";
import { devicesFor } from "../../lib/platforms";
import { refreshDevices, useDevices, useSelectedDeviceId } from "../../stores/deviceStore";
import { useProject } from "../../stores/projectStore";
import { getRunOptions } from "../../stores/runOptionsStore";
import { beginRun, useRunId, useRunStatus } from "../../stores/runStore";
import { CaseDetail, ids } from "./CaseDetail";
import { CaseDeviceStream } from "./CaseDeviceStream";
import { CaseRunStatus } from "./CaseRunStatus";
import { DatasourcePanel } from "./DatasourcePanel";
import { PlansPanel } from "./PlansPanel";
import styles from "./CasesView.module.css";

/** Columns come from a Qase custom field; `suite` is the always-present fallback. */
const SUITE_FIELD = "suite";

/** A case's values for the field the matrix is keyed on. */
function valuesOf(c: Case, field: string): string[] {
  return field === SUITE_FIELD ? (c.suite ? [c.suite] : []) : (c.custom_fields[field] ?? []);
}

/**
 * The flow covering a case on one column: the declaring flow tagged for it. A
 * case covered by a single flow needs no tag — one flow, one implementation.
 */
function flowFor(c: Case, column?: string): string | undefined {
  const flows = c.flows ?? [];
  if (!column) return flows[0]?.path;
  const tagged = flows.find((f) => f.tags.some((t) => t.replace(/-draft$/, "") === column));
  return tagged?.path ?? (flows.length === 1 ? flows[0].path : undefined);
}

/**
 * One cell of a 150-row matrix, so it is built for scanning down a column, not
 * for looking at on its own: left-aligned, one line, fixed width, and the state
 * carried by a dot the eye can follow.
 *
 *   hollow ring — automated by a flow
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
  testCase: Case;
  column: string;
  onRun: (flow: string, platform?: string, projectId?: string) => void;
}) {
  const flow = flowFor(c, column);

  let state: "pending" | "manual";
  let label: string;
  let title: string;

  if (flow) {
    state = "pending";
    label = "automated";
    title = flow;
  } else {
    state = "manual";
    label = "manual";
    title = "No flow here — verify by hand, or write one from the case's steps";
  }

  return (
    <span className={styles.cell} data-state={state} title={title}>
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
  const [pane, setPane] = useState<"case" | "plans" | "datasource">("case");
  const [projects, setProjects] = useState<QaseProject[]>([]);
  const [syncing, setSyncing] = useState(false);
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

  const refreshSource = useCallback(() => {
    fetchQaseProjects()
      .then(({ projects: list }) => setProjects(list))
      .catch(() => setProjects([]));
  }, [projectRoot]);

  useEffect(refresh, [refresh]);
  useEffect(refreshSource, [refreshSource]);
  useIpcEvent<unknown>("plans:run-updated", refresh);
  // A fetch from the agent's `sync_test_cases`, or a flow linking itself to a
  // case, lands here too.
  useIpcEvent<unknown>("cases:refreshed", () => {
    refresh();
    refreshSource();
  });
  useIpcEvent<unknown>("cases:linked", refresh);

  /** Fetch the latest cases from Qase into the cache. */
  const sync = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const summaries = await refreshCases();
      refresh();
      refreshSource();
      setNotice(
        summaries.map((s) => `${s.code}: ${s.cases} cases`).join(" · ") || "Nothing to fetch.",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setSyncing(false);
    }
  };

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

  const cases = matrix?.cases ?? [];

  // Every custom field the cases actually carry — the column picker and the
  // filter row are both driven by the data, not by a fixed list.
  const dimensions = useMemo(() => {
    const found = new Set([SUITE_FIELD, ...cases.flatMap((c) => Object.keys(c.custom_fields))]);
    return [...found].sort();
  }, [cases]);

  // Fall back to a flat list when the chosen grouping isn't in this project.
  useEffect(() => {
    if (groupBy !== "none" && cases.length && !dimensions.includes(groupBy)) setGroupBy("none");
  }, [cases.length, dimensions, groupBy]);

  const filterable = useMemo(
    () =>
      [
        ...dimensions
          .filter((d) => d !== dimension)
          .map((d) => ({ dimension: d, values: [...new Set(cases.flatMap((c) => valuesOf(c, d)))].sort() })),
        { dimension: "tags", values: [...new Set(cases.flatMap((c) => c.tags))].sort() },
        { dimension: "priority", values: [...new Set(cases.map((c) => c.priority ?? ""))].filter(Boolean).sort() },
        { dimension: "status", values: [...new Set(cases.map((c) => c.status))].sort() },
      ].filter((f) => f.values.length > 1),
    [dimensions, dimension, cases],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases.filter((c) => {
      for (const [field, value] of Object.entries(filters)) {
        if (!value) continue;
        const have =
          field === "tags"
            ? c.tags
            : field === "priority"
              ? [c.priority ?? ""]
              : field === "status"
                ? [c.status]
                : valuesOf(c, field);
        if (!have.includes(value)) return false;
      }
      if (!q) return true;
      const haystack = [
        c.ref,
        c.title,
        c.description ?? "",
        c.suite ?? "",
        ...c.tags,
        ...(c.flows ?? []).map((f) => f.path),
      ];
      return haystack.some((s) => s.toLowerCase().includes(q));
    });
  }, [cases, filters, query]);

  // `#/cases/<id>` is what's open: the URL survives leaving the screen, and it
  // is how a report links back to the case it verified.
  const selectedId = useRoute().caseId ?? null;
  const selected = useMemo(() => cases.find((c) => c.ref === selectedId) ?? null, [cases, selectedId]);

  const toRow = useCallback(
    (c: Case, columnsOf: string[]): MatrixRow => {
      const values = valuesOf(c, dimension);
      const cells: Record<string, React.ReactNode> = {};
      for (const col of columnsOf) {
        if (!values.includes(col)) continue;
        cells[col] = (
          <CaseCell testCase={c} column={col} onRun={run} />
        );
      }
      const breadcrumb = groupBy === SUITE_FIELD ? undefined : c.suite;
      return {
        id: c.ref,
        label: c.title,
        sublabel: [ids(c), breadcrumb, c.priority].filter(Boolean).join("  ·  "),
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
    const buckets = new Map<string, Case[]>();
    for (const c of visible) {
      // A case with several values for the field belongs to the first —
      // duplicating it across bands would double every count on the screen.
      const key = valuesOf(c, groupBy)[0] ?? "Ungrouped";
      buckets.set(key, [...(buckets.get(key) ?? []), c]);
    }
    const names = [...buckets.keys()].sort((a, b) =>
      a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b),
    );
    return names.map((name) => {
      const scoped = buckets.get(name)!;
      const automated = scoped.filter((c) => c.flows?.length).length;
      return {
        id: name,
        label: name,
        collapsed: collapsed.has(name),
        meta: `${automated}/${scoped.length} automated`,
        rows: [...scoped]
          .sort((a, b) => (a.suite ?? "").localeCompare(b.suite ?? "") || a.id - b.id)
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
        const scoped = cases.filter((c) => valuesOf(c, matrix!.field).includes(col));
        return { col, covered: scoped.filter((c) => flowFor(c, col)).length, total: scoped.length };
      }),
    [matrix, cases],
  );

  const openCase = (id: string) => {
    selectCase(id);
    setPane("case");
  };

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Test cases</h1>
          <p className={styles.subtitle}>
            The spec, and what implements it.
          </p>
        </div>
        <div className={styles.controls}>
          <Button size="sm" variant="ghost" icon="matrix" onClick={() => setPane("plans")}>
            Plans
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
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            disabled={syncing || !projects.length}
            title={projects.length ? undefined : "Add a Qase project first"}
            onClick={() => void sync()}
          >
            {syncing ? "Fetching…" : "Fetch from Qase"}
          </Button>
          <Button size="sm" variant="ghost" icon="settings" onClick={() => setPane("datasource")}>
            {projects.length ? `Qase · ${projects.map((p) => p.code).join(", ")}` : "Qase projects"}
          </Button>
          <Button size="sm" variant="ghost" icon="refresh" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </header>

      <div className={styles.filters}>
        <TextField
          icon="search"
          placeholder="Search cases, ids, suites, flows…"
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
                  : "Create one, or import a CSV from the tool you're moving off. Cases are YAML files under ~/.conductor/studio/<project>/cases/, kept out of the repo under test."
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

        {pane === "plans" ? (
          <PlansPanel
            currentFilter={Object.fromEntries(
              Object.entries(filters)
                .filter(([, v]) => v)
                .map(([dim, v]) => [dim, [v]]),
            )}
            onClose={() => setPane("case")}
          />
        ) : pane === "datasource" ? (
          <DatasourcePanel
            fields={dimensions}
            onClose={() => setPane("case")}
            onChanged={() => {
              refresh();
              refreshSource();
            }}
          />
        ) : selected ? (
          <CaseDetail
            testCase={selected}
            onClose={closeCase}
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

    </div>
  );
}
