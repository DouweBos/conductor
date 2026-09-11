import { Button, Icon, Panel, StatusPill, TextField, type StatusTone } from "@conductor/studio-ui";
import { useState } from "react";

import type { CampaignProgress, GoalTargetStatus, ParityGoal } from "../../lib/types";
import { haltCampaign, refreshGoal, removeGoal, setGoalDeepLink, startCampaign } from "../../stores/parityStore";
import styles from "./CampaignPanel.module.css";

/**
 * The queue of screens a rebuild is being held to, and where each target
 * stands on each — Helix's "sequence of checkpoints", with a burn-down.
 *
 * Runs goal by goal. Review is never waited for: a goal whose targets all reach
 * review is done as far as the queue is concerned, and reviews are caught up on
 * separately. A stalled or failed target is retried on the next run, so the
 * queue can be re-run until it is empty.
 */

const TONE: Record<GoalTargetStatus, StatusTone> = {
  pending: "neutral",
  converging: "running",
  review: "info",
  accepted: "success",
  recheck: "warning",
  stalled: "warning",
  failed: "error",
};

function summarise(campaign: CampaignProgress["campaign"]): {
  goals: number;
  accepted: number;
  total: number;
  review: number;
  recheck: number;
  stuck: number;
  usd: number;
  ms: number;
} {
  let accepted = 0;
  let total = 0;
  let review = 0;
  let recheck = 0;
  let stuck = 0;
  let usd = 0;
  let ms = 0;
  for (const g of campaign.goals) {
    usd += g.spent?.usd ?? 0;
    ms += g.spent?.ms ?? 0;
    for (const t of g.targets) {
      total += 1;
      const s = g.status[t.label] ?? "pending";
      if (s === "accepted") accepted += 1;
      else if (s === "review") review += 1;
      else if (s === "recheck") recheck += 1;
      else if (s === "stalled" || s === "failed") stuck += 1;
    }
  }
  return { goals: campaign.goals.length, accepted, total, review, recheck, stuck, usd, ms };
}

function GoalRow({
  goal,
  current,
  waitingFor,
  running,
}: {
  goal: ParityGoal;
  current: boolean;
  waitingFor: string[] | null;
  running: boolean;
}) {
  const [deepLink, setDeepLink] = useState(goal.route?.deepLink ?? "");
  const [editingLink, setEditingLink] = useState(false);
  const age = Math.round((Date.now() - goal.referenceCapturedAt) / 86_400_000);
  const route = goal.route;
  const steps = goal.interaction?.length ?? 0;
  const spent = goal.spent;
  const routeText = route?.deepLink
    ? `deep link`
    : route?.steps.length
      ? `${route.steps.length}-step route`
      : "no route — the agent navigates";

  return (
    <li className={[styles.goal, current && styles.current].filter(Boolean).join(" ")}>
      <div className={styles.head}>
        <span className={styles.name}>{goal.checkpoint}</span>
        {current ? <StatusPill tone="running">converging</StatusPill> : null}
        {waitingFor ? (
          <span title={`Waiting for a device: ${waitingFor.join(", ")}`}>
            <StatusPill tone="warning">
              waiting for {waitingFor.length === 1 ? waitingFor[0] : `${waitingFor.length} devices`}
            </StatusPill>
          </span>
        ) : null}
        <span className={styles.meta}>
          {routeText}
          {steps ? ` · ${steps}-step interaction` : ""}
          {" · "}reference {age === 0 ? "captured today" : `${age}d old`}
          {spent && spent.rounds
            ? ` · ${spent.rounds} rounds, ${Math.round(spent.ms / 60_000)} min${spent.usd ? `, $${spent.usd.toFixed(2)}` : ""}`
            : ""}
        </span>
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          disabled={running}
          title="Re-capture the reference by replaying the route on its device, and see whether the screen moved"
          onClick={() => void refreshGoal(goal.id)}
        >
          Refresh
        </Button>
        <Button size="sm" variant="ghost" icon="code" onClick={() => setEditingLink((v) => !v)}>
          Deep link
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          disabled={running}
          aria-label={`Remove goal ${goal.checkpoint}`}
          onClick={() => void removeGoal(goal.id)}
        />
      </div>

      {editingLink ? (
        <form
          className={styles.linkForm}
          onSubmit={(e) => {
            e.preventDefault();
            void setGoalDeepLink(goal.id, deepLink).then(() => setEditingLink(false));
          }}
        >
          <TextField
            value={deepLink}
            onChange={(e) => setDeepLink(e.target.value)}
            placeholder="myapp://detail/123 — opens the screen directly, instead of replaying steps"
            aria-label={`Deep link for ${goal.checkpoint}`}
          />
          <Button size="sm" type="submit">
            Save
          </Button>
        </form>
      ) : null}

      {goal.drift ? (
        <p className={styles.drift}>
          <Icon name="alert" size={12} /> The reference moved: {goal.drift.blocking} blocking
          difference(s) — {goal.drift.summary}. Accepted targets are back for recheck.
        </p>
      ) : null}

      <ul className={styles.targets}>
        {goal.targets.map((t) => {
          const s = goal.status[t.label] ?? "pending";
          return (
            <li key={t.label} className={styles.target}>
              <span className={styles.targetLabel}>{t.label}</span>
              <StatusPill tone={TONE[s]}>{s}</StatusPill>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function CampaignPanel({ campaign }: { campaign: CampaignProgress | null }) {
  if (!campaign || campaign.campaign.goals.length === 0) return null;
  const s = summarise(campaign.campaign);
  const active = campaign.activeGoalIds ?? [];
  const waiting = new Map((campaign.waiting ?? []).map((w) => [w.goalId, w.needs]));

  return (
    <Panel
      title={`Campaign · ${s.goals} screen${s.goals === 1 ? "" : "s"}`}
      actions={
        <span className={styles.actions}>
          <span className={styles.burndown}>
            {s.accepted}/{s.total} accepted
            {s.review ? ` · ${s.review} to review` : ""}
            {s.recheck ? ` · ${s.recheck} to recheck` : ""}
            {s.stuck ? ` · ${s.stuck} stuck` : ""}
            {s.ms ? ` · ${Math.round(s.ms / 60_000)} min` : ""}
            {s.usd ? ` · $${s.usd.toFixed(2)}` : ""}
            {campaign.running && active.length > 1 ? ` · ${active.length} at once` : ""}
          </span>
          {campaign.running ? (
            <Button size="sm" variant="secondary" icon="stop" onClick={() => void haltCampaign()}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              icon="play"
              title="Work every goal with something left to do — as many at once as there are free devices"
              onClick={() => void startCampaign()}
            >
              Run queue
            </Button>
          )}
        </span>
      }
    >
      <p className={styles.note}>
        Each screen is held to the reference captured when it was queued. <strong>Refresh</strong>{" "}
        re-captures a reference and, if the screen moved, sends accepted targets back for recheck —
        the app being ported from keeps shipping while the port happens.
      </p>
      <ol className={styles.goals}>
        {campaign.campaign.goals.map((g) => (
          <GoalRow
            key={g.id}
            goal={g}
            current={active.includes(g.id)}
            waitingFor={waiting.get(g.id) ?? null}
            running={campaign.running}
          />
        ))}
      </ol>
    </Panel>
  );
}
