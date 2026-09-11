import { Button, Icon, Panel, Spinner, StatusPill, TextField } from "@conductor/studio-ui";
import { useState } from "react";

import type { PlanProgress, PlanProposal, Route } from "../../lib/types";
import {
  captureProposal,
  clearPlan,
  planFromGraph,
  planWithAgent,
  removeProposal,
  setProposalDeepLink,
} from "../../stores/parityStore";
import styles from "./PlanPanel.module.css";

/**
 * The planner: the screens a port should be held to, before any is a goal.
 *
 * Two sources fill it. The scene graph Studio recorded while the reference was
 * explored gives every screen seen and the route that led there; an agent
 * reading the reference's source gives the screens nobody has navigated to
 * yet and the deep links its router defines. Either way it is a proposal — a
 * person captures the ones that matter, and each becomes a campaign goal.
 */

function describeRoute(route: Route): string {
  if (route.deepLink) return `opens ${route.deepLink}`;
  if (route.steps.length) return `${route.steps.length}-step route${route.appId ? ` from ${route.appId}` : ""}`;
  if (route.appId) return `the launch screen of ${route.appId}`;
  return "no route — the agent navigates";
}

function ProposalRow({
  proposal,
  capturing,
  canCapture,
}: {
  proposal: PlanProposal;
  capturing: boolean;
  canCapture: boolean;
}) {
  const [link, setLink] = useState(proposal.route?.deepLink ?? "");
  const [editing, setEditing] = useState(false);
  const routeText = proposal.route ? describeRoute(proposal.route) : "no route — the agent navigates";

  return (
    <li className={styles.proposal}>
      <div className={styles.head}>
        <span className={styles.name}>{proposal.name}</span>
        <StatusPill tone={proposal.source === "scene-graph" ? "info" : "neutral"}>
          {proposal.source === "scene-graph" ? "from the graph" : "from the source"}
        </StatusPill>
        {proposal.goalId ? <StatusPill tone="success">queued</StatusPill> : null}
        {capturing ? <Spinner size={12} /> : null}
        <span className={styles.spacer} />
        {!proposal.goalId ? (
          <Button
            size="sm"
            icon="camera"
            disabled={!canCapture || capturing}
            title="Drive the reference along the route, capture the screen, and queue it as a goal for the current targets"
            onClick={() => void captureProposal(proposal.id)}
          >
            Capture as goal
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="code" onClick={() => setEditing((v) => !v)}>
          Deep link
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          disabled={capturing}
          aria-label={`Remove proposal ${proposal.name}`}
          onClick={() => void removeProposal(proposal.id)}
        />
      </div>
      <p className={styles.meta}>
        {routeText}
        {proposal.rationale ? ` · ${proposal.rationale}` : ""}
      </p>
      {proposal.unreplayable?.length ? (
        <p className={styles.warn}>
          <Icon name="alert" size={12} /> Part of the recorded route cannot be replayed blind:{" "}
          {proposal.unreplayable.join("; ")}. Give it a deep link, or capture it with the reference
          already on the screen.
        </p>
      ) : null}
      {proposal.error ? (
        <p className={styles.error}>
          <Icon name="alert" size={12} /> {proposal.error}
        </p>
      ) : null}
      {editing ? (
        <form
          className={styles.linkForm}
          onSubmit={(e) => {
            e.preventDefault();
            void setProposalDeepLink(proposal.id, link).then(() => setEditing(false));
          }}
        >
          <TextField
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="myapp://detail/123 — opens the screen directly on the reference"
            aria-label={`Deep link for ${proposal.name}`}
          />
          <Button size="sm" type="submit">
            Save
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export function PlanPanel({
  plan,
  canCapture,
}: {
  plan: PlanProgress | null;
  /** A reference device and at least one target are set. */
  canCapture: boolean;
}) {
  const [sourceDir, setSourceDir] = useState("");
  const proposals = plan?.plan.proposals ?? [];
  const planning = plan?.planning === true;
  const queued = proposals.filter((p) => p.goalId).length;

  return (
    <Panel
      title={proposals.length ? `Plan · ${proposals.length} screen${proposals.length === 1 ? "" : "s"}` : "Plan"}
      actions={
        <span className={styles.actions}>
          {proposals.length ? (
            <span className={styles.summary}>
              {queued}/{proposals.length} queued
            </span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            icon="flow"
            disabled={planning}
            title="Every screen recorded while the reference was explored, shallowest first, with the route that led there"
            onClick={() => void planFromGraph()}
          >
            From the scene graph
          </Button>
          {proposals.length ? (
            <Button size="sm" variant="ghost" icon="trash" disabled={planning} onClick={() => void clearPlan()}>
              Clear
            </Button>
          ) : null}
        </span>
      }
    >
      <p className={styles.note}>
        Which screens should the port be held to, and in what order? Propose them from what Studio
        saw while you explored the reference, or point an agent at the reference&apos;s source to
        list the screens its router knows — then <strong>Capture as goal</strong> the ones that
        matter. Each becomes a campaign goal for the targets in the workspace.
      </p>

      <form
        className={styles.sourceForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!sourceDir.trim()) return;
          void planWithAgent(sourceDir);
        }}
      >
        <TextField
          value={sourceDir}
          onChange={(e) => setSourceDir(e.target.value)}
          placeholder="Reference source directory, e.g. apps/tv — the agent reads its router and screens"
          aria-label="Reference source directory"
          disabled={planning}
        />
        <Button size="sm" type="submit" icon="agent" disabled={planning || !sourceDir.trim()}>
          {planning ? "Reading the source…" : "Ask the agent"}
        </Button>
        {planning ? <Spinner size={14} /> : null}
      </form>

      {proposals.length ? (
        <ol className={styles.proposals}>
          {proposals.map((p) => (
            <ProposalRow
              key={p.id}
              proposal={p}
              capturing={plan?.capturingId === p.id}
              canCapture={canCapture && !plan?.capturingId}
            />
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>Nothing proposed yet.</p>
      )}
    </Panel>
  );
}
