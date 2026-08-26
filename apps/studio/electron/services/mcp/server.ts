/**
 * Conductor Studio MCP server — exposes the scene graph to the Claude agent
 * Studio spawns, so it can navigate the app by path instead of re-exploring.
 *
 * Streamable HTTP on a random loopback port, guarded by a per-launch bearer
 * token that only the spawned agent learns (via --mcp-config). Mirrors the
 * Argus MCP server's transport/auth setup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "node:crypto";
import http from "node:http";
import { z } from "zod";

import type { AppFingerprint, ResultStatus, SceneNode, TestVerdict } from "../../../app/lib/types";
import { listCases, projects as qaseProjects, refreshCases } from "../cases/casesService";
import { linkFlow } from "../cases/coverage";
import { scaffoldFlow } from "../cases/pomBridge";
import { recordResult } from "../cases/resultsService";
import { createReportDir, writeReport } from "../report/reportService";
import { recordExpectation, startSession } from "../report/testSession";
import { findPath, type SceneGraphIndex } from "../scenegraph/graph";
import {
  currentApp,
  findAppByKey,
  getSceneGraphIndex,
  listSceneGraphs,
} from "../scenegraph/sceneGraphService";

let httpServer: http.Server | null = null;
let mcpPort: number | null = null;
let mcpAuthToken: string | null = null;

export function getMcpPort(): number | null {
  return mcpPort;
}

export function getMcpAuthToken(): string | null {
  return mcpAuthToken;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // Only spawned subprocesses talk to this server, so a browser Origin header
  // means a DNS-rebinding attempt.
  if (req.headers.origin) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "cross-origin requests not allowed" }));
    return false;
  }
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "host not allowed" }));
    return false;
  }
  if (!mcpAuthToken) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "MCP server not initialized" }));
    return false;
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m || !timingSafeEqualStr(m[1].trim(), mcpAuthToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

function text(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Resolve a screen argument, returning MCP error content when ambiguous. */
async function resolveScreen(
  index: SceneGraphIndex,
  query: string,
): Promise<{ node: SceneNode } | { error: ReturnType<typeof text> }> {
  const hit = index.resolve(query);
  if ("node" in hit) return { node: hit.node };
  return {
    error: text({
      error: hit.candidates.length
        ? `"${query}" is ambiguous — pass an exact id.`
        : `No screen matches "${query}".`,
      candidates: hit.candidates.map((n) => ({ id: n.id, label: n.label })),
      known_screens: index.nodes.map((n) => ({ id: n.id, label: n.label })),
    }),
  };
}

const appArg = z
  .string()
  .optional()
  .describe(
    "Which app's scene graph to read — bundle/package id, app name, or storage key from list_apps. Defaults to the app the last capture-ui saw in the foreground.",
  );

/** Resolve the target app, or explain why there isn't one. */
async function resolveApp(
  app: string | undefined,
): Promise<{ app: AppFingerprint } | { error: ReturnType<typeof text> }> {
  if (app) {
    const found = await findAppByKey(app);
    if (found) return { app: found };
    return {
      error: text({
        error: `No scene graph recorded for "${app}".`,
        recorded_apps: await listSceneGraphs(),
      }),
    };
  }
  const active = currentApp();
  if (active) return { app: active };
  return {
    error: text({
      error:
        "No app identified yet — run capture-ui on the device first, or pass `app` explicitly.",
      recorded_apps: await listSceneGraphs(),
    }),
  };
}

/** An agentic verdict, in the vocabulary the results log speaks. */
const REPORT_VERDICT: Record<TestVerdict, ResultStatus> = {
  PASS: "passed",
  FAIL: "failed",
  BLOCKED: "blocked",
};

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "conductor-studio", version: "1.0.0" });

  server.tool(
    "list_apps",
    "List every app that has a recorded scene graph, with its bundle/package id, platform, and screen count. Use this to find the `app` argument for the other tools.",
    {},
    async () => text({ current: currentApp(), recorded_apps: await listSceneGraphs() }),
  );

  server.tool(
    "list_screens",
    "List every screen recorded in this project's scene graph, with how many transitions lead in and out. Use this to see what the app's explored surface looks like before navigating.",
    { app: appArg },
    async ({ app }) => {
      const target = await resolveApp(app);
      if ("error" in target) return target.error;
      const index = await getSceneGraphIndex(target.app);
      return text({
        app: target.app,
        screens: index.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          outgoing: index.edgesFrom(n.id).length,
          incoming: index.edgesTo(n.id).length,
        })),
      });
    },
  );

  server.tool(
    "describe_screen",
    "Show one screen's transitions: the actions that lead away from it and the actions that lead to it. Use before deciding how to leave or reach a screen.",
    {
      screen: z
        .string()
        .describe("Screen id (e.g. screen-3), exact label, or a unique substring of either."),
      app: appArg,
    },
    async ({ screen, app }) => {
      const target = await resolveApp(app);
      if ("error" in target) return target.error;
      const index = await getSceneGraphIndex(target.app);
      const hit = await resolveScreen(index, screen);
      if ("error" in hit) return hit.error;
      const label = (id: string) => index.node(id)?.label ?? id;
      return text({
        id: hit.node.id,
        label: hit.node.label,
        outgoing: index.edgesFrom(hit.node.id).map((e) => ({ action: e.action, to: label(e.to) , to_id: e.to })),
        incoming: index.edgesTo(hit.node.id).map((e) => ({ action: e.action, from: label(e.from), from_id: e.from })),
      });
    },
  );

  server.tool(
    "find_path",
    "Find the shortest recorded route between two screens (A* over the transition graph) and return the ordered actions to perform. Use this to navigate instead of exploring the app by trial and error.",
    {
      from: z.string().describe("Starting screen — id, exact label, or unique substring."),
      to: z.string().describe("Destination screen — id, exact label, or unique substring."),
      app: appArg,
    },
    async ({ from, to, app }) => {
      const target = await resolveApp(app);
      if ("error" in target) return target.error;
      const index = await getSceneGraphIndex(target.app);
      const start = await resolveScreen(index, from);
      if ("error" in start) return start.error;
      const goal = await resolveScreen(index, to);
      if ("error" in goal) return goal.error;

      const path = findPath(index, start.node.id, goal.node.id);
      if (!path) {
        return text({
          reachable: false,
          message: `No recorded route from "${start.node.label}" to "${goal.node.label}". Explore the app and capture the UI along the way to record one.`,
        });
      }
      const label = (id: string) => index.node(id)?.label ?? id;
      return text({
        reachable: true,
        steps: path.steps.length,
        route: path.nodeIds.map(label),
        actions: path.steps.map((s) => ({ from: label(s.from), action: s.action, to: label(s.to) })),
      });
    },
  );

  server.tool(
    "start_test_report",
    "Open an agentic test run: declare the plan up front and get a folder for its artefacts. Call this BEFORE driving the app — Studio shows the plan as a live checklist beside the device, and ticks each expectation off as you record it.",
    {
      title: z.string().describe("Short name for the test, e.g. \"Watchlist add/remove\"."),
      description: z.string().optional().describe("The user's original request, verbatim."),
      plan: z
        .object({
          preconditions: z.array(z.string()).optional().describe("Required starting state."),
          actions: z.array(z.string()).optional().describe("The ordered steps you will perform."),
          expectations: z
            .array(z.string())
            .optional()
            .describe("What must be observably true, each phrased as something you can assert."),
        })
        .optional()
        .describe("The plan you showed the user. Every expectation here should end up recorded."),
    },
    async ({ title, description, plan }) => {
      const { id, dir } = await createReportDir(title);
      startSession({ id, dir, title, description, plan });
      return text({
        id,
        reportDir: dir,
        note: "Record each expectation with `record_expectation` as it resolves — Studio captures the screen for you at that moment, so you don't need to take screenshots by hand.",
      });
    },
  );

  server.tool(
    "record_expectation",
    "Mark one expectation resolved, the moment it resolves. Studio captures the device screen as evidence and ticks the live checklist. Call it right after the structured check that decided it — one call per expectation, including the ones that fail.",
    {
      text: z.string().describe("The expectation, worded as in the plan."),
      status: z
        .enum(["pass", "fail", "info"])
        .describe("What the check returned. `info` for an observation that doesn't decide the verdict."),
      evidence: z
        .string()
        .optional()
        .describe("The exact tool output that decided it — copy it, don't paraphrase."),
      element: z
        .string()
        .optional()
        .describe(
          "Label or accessibility id of the element the check was about; it gets outlined in the captured screenshot.",
        ),
      capture: z
        .boolean()
        .optional()
        .describe("Set false for a check that isn't about what's on screen — skips the capture."),
    },
    async (input) => {
      const recorded = await recordExpectation(input);
      return text({
        recorded: recorded.text,
        status: recorded.status,
        screenshot: recorded.screenshot ?? "none (no device, or capture skipped)",
        outlined: recorded.highlight ? input.element : undefined,
      });
    },
  );

  server.tool(
    "write_test_report",
    "Render the run-log you kept while testing into a self-contained HTML + PDF report and file it under this project's reports. Call this once at the end of every agentic test — on PASS, FAIL and BLOCKED alike — then tell the user the verdict and the report path.",
    {
      dir: z
        .string()
        .optional()
        .describe("The reportDir from start_test_report. Omit to create a fresh folder."),
      caseId: z
        .string()
        .optional()
        .describe("Test case this run verified (from list_test_cases), so the result lands on the matrix."),
      runLog: z
        .object({
          title: z.string().describe("Short name for the test."),
          description: z.string().optional().describe("The user's original test request, verbatim."),
          platform: z.string().optional().describe("e.g. \"iOS (iPhone 17 Pro)\"."),
          device: z.string().optional().describe("Device name and udid."),
          verdict: z
            .enum(["PASS", "FAIL", "BLOCKED"])
            .describe("PASS only when every expectation was verified with a structured check."),
          startedAt: z.string().optional(),
          finishedAt: z.string().optional(),
          summary: z.string().optional().describe("One human paragraph: what happened and why the verdict."),
          plan: z
            .object({
              preconditions: z.array(z.string()).optional(),
              actions: z.array(z.string()).optional(),
              expectations: z.array(z.string()).optional(),
            })
            .optional(),
          expectations: z
            .array(
              z.object({
                text: z.string(),
                status: z.enum(["pass", "fail", "info"]),
                evidence: z
                  .string()
                  .optional()
                  .describe("The exact tool output that decided it — copy it, don't paraphrase."),
              }),
            )
            .optional()
            .describe(
              "One row per expectation from the plan. Anything already sent to `record_expectation` is merged in with its screenshot — repeat it here only to reword it.",
            ),
          steps: z
            .array(
              z.object({
                n: z.number().optional(),
                kind: z.enum(["action", "assert"]).optional(),
                title: z.string(),
                status: z.enum(["pass", "fail", "info"]).optional(),
                detail: z.string().optional(),
                evidence: z.string().optional(),
                screenshot: z
                  .string()
                  .optional()
                  .describe("Path to a screenshot, absolute or relative to the report dir."),
              }),
            )
            .optional()
            .describe("The timeline, in order."),
        })
        .describe("The run-log to render."),
    },
    async ({ dir, runLog, caseId }) => {
      const report = await writeReport(runLog, dir, caseId);
      // An agentic verification of a case IS an execution of it — file it, so a
      // case with no flow still gets a result on the matrix. The verdict is the
      // reconciled one: a PASS over a failed check was already corrected.
      if (caseId) {
        const hit = (await listCases()).find((c) => c.ref === caseId || String(c.id) === caseId);
        if (hit) {
          await recordResult({
            case_id: hit.id,
            ref: hit.ref,
            status: REPORT_VERDICT[report.verdict] ?? "blocked",
            source: "report",
            report_id: report.id,
            comment: runLog.summary,
            author: "agent",
          }).catch(() => null);
        }
      }
      return text({
        ...report,
        // Times, platform and device come from Studio, not from the run-log —
        // say so, so the agent doesn't "fix" them on a later call.
        note:
          "Studio stamped the start/finish times and the device, and checked the verdict against the expectations." +
          (report.adjustments?.length ? " It corrected the verdict — see `adjustments`." : ""),
      });
    },
  );

  server.tool(
    "list_test_cases",
    "List this project's test cases: id, title, suite, custom fields, tags, the flows that declare each (if any) and its last recorded result. Use this to find work — a case no flow declares is unautomated — or to check what a case expects before testing it.",
    {
      query: z
        .string()
        .optional()
        .describe("Filter by id, title, tag or custom field value. Omit for everything."),
      unautomatedOnly: z.boolean().optional().describe("Only cases with no flow yet."),
    },
    async ({ query, unautomatedOnly }) => {
      const q = query?.toLowerCase();
      const cases = (await listCases()).filter((c) => {
        if (unautomatedOnly && c.flows?.length) return false;
        if (!q) return true;
        const hay = [c.ref, c.title, c.suite ?? "", ...c.tags, ...Object.values(c.custom_fields).flat()];
        return hay.some((h) => h.toLowerCase().includes(q));
      });
      return text({
        total: cases.length,
        cases: cases.map((c) => ({
          id: c.ref,
          title: c.title,
          suite: c.suite,
          status: c.status,
          priority: c.priority,
          custom_fields: c.custom_fields,
          tags: c.tags,
          flows: (c.flows ?? []).map((f) => ({ path: f.path, tags: f.tags })),
          lastResult: c.lastResult ? { status: c.lastResult.status, at: c.lastResult.at } : null,
        })),
      });
    },
  );

  server.tool(
    "describe_test_case",
    "Everything one test case specifies: description, steps (action/data/expected_result), suite, custom fields, tags, the flows that declare it and its execution history. Read this before automating or verifying the case — the steps are the script.",
    { id: z.string().describe("Case id, e.g. DEMO-12.") },
    async ({ id }) => {
      const cases = await listCases();
      const hit = cases.find((c) => c.ref === id || String(c.id) === id);
      if (!hit) {
        return text({ error: `No case "${id}".`, known_ids: cases.slice(0, 50).map((c) => c.ref) });
      }
      return text(hit);
    },
  );

  server.tool(
    "get_cases_datasource",
    "Where this project's test cases come from, and how a flow is linked to one. Check it before proposing any change to a case.",
    {},
    async () => {
      return text({
        source: "qase",
        projects: qaseProjects().map((p) => ({
          code: p.code,
          matrixField: p.matrixField ?? "suite",
          fetchedAt: p.fetchedAt ?? null,
          hasToken: Boolean(p.hasToken),
        })),
        caseContentReadOnly: true,
        linkedBy: "properties.testCaseId in the flow header",
        guidance:
          "Cases are authored in Qase and read-only here. A flow declares the case it verifies in its own header (`properties: { testCaseId: \"MC-12\" }`) — that is the only link, and Maestro carries it into the JUnit report. Use `link_case_flow` to write it.",
      });
    },
  );

  server.tool(
    "sync_test_cases",
    "Fetch the latest test cases from Qase into Studio's cache. Run it before starting work so you are not automating a stale case. Nothing local is overwritten — the cache is all Studio keeps, and flow links live in the flows.",
    {},
    async () => {
      try {
        return text(await refreshCases());
      } catch (e) {
        return text({ error: String(e) });
      }
    },
  );

  server.tool(
    "scaffold_case_flow",
    "Write a Maestro flow skeleton from a test case's steps and link it to that case. Steps naming a page object become runFlow calls with their env; steps without one become TODOs in the file. Start here when automating a case — then fill in the TODOs and run it.",
    {
      id: z.string().describe("Case id, e.g. DEMO-12."),
      column: z
        .string()
        .optional()
        .describe("Matrix column this flow covers (tv, mobile). Omit for a single-platform case."),
      target: z
        .string()
        .optional()
        .describe("Flows-relative path to write. Defaults to flows/cases/<id>[.<column>].yaml."),
    },
    async ({ id, column, target }) => {
      try {
        return text(await scaffoldFlow({ ref: id, column, target }));
      } catch (e) {
        return text({ error: String(e) });
      }
    },
  );

  server.tool(
    "link_case_flow",
    "Declare which test case a flow verifies, by writing `properties.testCaseId` into the flow's own header. Use after writing or renaming a flow by hand. This edits the flow, not the case: Qase's content is never touched, and the link travels with the repo into CI's JUnit report.",
    {
      flow: z.string().describe("Flow path relative to the flows directory."),
      ids: z
        .array(z.string())
        .describe("Case ids the flow verifies, e.g. [\"MC-12\"]. Pass an empty array to unlink."),
    },
    async ({ flow, ids }) => {
      const known = new Set((await listCases()).map((c) => c.ref));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) {
        return text({
          error: `No test case ${unknown.join(", ")}. Refresh from Qase, or check the id.`,
        });
      }
      try {
        return text(await linkFlow(flow, ids));
      } catch (e) {
        return text({ error: String(e) });
      }
    },
  );

  server.tool(
    "record_case_result",
    "File the outcome of testing a case, so the matrix reflects it. Use after verifying a case by driving the device (write_test_report already records its own result when given a caseId).",
    {
      id: z.string().describe("Case id, e.g. DEMO-12."),
      status: z
        .enum(["passed", "failed", "blocked", "skipped", "invalid"])
        .describe("Qase's result statuses. `invalid` means the case itself is wrong."),
      column: z
        .string()
        .optional()
        .describe("Matrix column this covered, when the case has one flow per column."),
      comment: z.string().optional().describe("One line on what decided the result."),
    },
    async ({ id, status, column, comment }) => {
      const hit = (await listCases()).find((c) => c.ref === id || String(c.id) === id);
      if (!hit) return text({ error: `No case "${id}".` });
      return text(
        await recordResult({
          case_id: hit.id,
          ref: hit.ref,
          status,
          column,
          comment,
          source: "report",
          author: "agent",
        }),
      );
    },
  );

  return server;
}

export async function startMcpServer(): Promise<number> {
  if (httpServer) throw new Error("MCP server is already running");
  mcpAuthToken = crypto.randomBytes(32).toString("hex");

  const transports = new Map<string, StreamableHTTPServerTransport>();

  httpServer = http.createServer(async (req, res) => {
    if (!authorizeRequest(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        // Each MCP session needs its own server: the SDK's Server supports one
        // active transport at a time.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        await createMcpServer().connect(transport);
      }
      await transport.handleRequest(req, res);
      // The session id is minted during the initialize handshake inside
      // handleRequest, so store the transport only afterwards.
      if (transport.sessionId && !transports.has(transport.sessionId)) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (req.method === "GET") {
      if (!transport) {
        res.writeHead(400);
        res.end("No active session");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method === "DELETE") {
      if (!transport) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }
      await transport.handleRequest(req, res);
      transports.delete(sessionId!);
      return;
    }
    res.writeHead(405);
    res.end("Method Not Allowed");
  });

  return new Promise((resolve, reject) => {
    httpServer!.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address();
      if (typeof addr === "object" && addr) {
        mcpPort = addr.port;
        resolve(mcpPort);
      } else {
        reject(new Error("Failed to get MCP server address"));
      }
    });
    httpServer!.on("error", reject);
  });
}

export function stopMcpServer(): void {
  if (!httpServer) return;
  httpServer.close();
  httpServer = null;
  mcpPort = null;
  mcpAuthToken = null;
}
