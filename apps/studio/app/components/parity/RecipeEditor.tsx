import { Button, TextField } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import type { ParityTarget, TargetRecipe } from "../../lib/types";
import { removeRecipe, saveRecipe } from "../../stores/parityStore";
import styles from "./RecipeEditor.module.css";

/**
 * How a target is rebuilt and put back on screen.
 *
 * Every field is optional and the loop degrades honestly: no build command and
 * the agent is asked to rebuild itself; no app id and it is asked to navigate
 * itself. Fill them in and those two least-reliable steps leave the agent's
 * hands entirely.
 */
export function RecipeEditor({
  target,
  recipe,
  onClose,
}: {
  target: ParityTarget;
  recipe: TargetRecipe | undefined;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TargetRecipe>(() => ({
    label: target.label,
    platform: target.platform,
    appId: recipe?.appId ?? "",
    sourceDir: recipe?.sourceDir ?? "",
    build: recipe?.build ?? { command: "" },
    reload: recipe?.reload ?? { command: "" },
    install: recipe?.install ?? { command: "" },
    test: recipe?.test ?? { command: "" },
  }));

  useEffect(() => {
    setDraft((d) => ({ ...d, label: target.label, platform: target.platform }));
  }, [target.label, target.platform]);

  const field = (
    key: "build" | "reload" | "install" | "test",
    label: string,
    hint: string,
  ) => (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <TextField
        value={draft[key]?.command ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: { ...d[key], command: e.target.value } }))}
        placeholder={hint}
        aria-label={`${label} command for ${target.label}`}
      />
    </label>
  );

  return (
    <form
      className={styles.editor}
      onSubmit={(e) => {
        e.preventDefault();
        void saveRecipe(draft).then(onClose);
      }}
    >
      <label className={styles.row}>
        <span className={styles.label}>App id</span>
        <TextField
          value={draft.appId ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, appId: e.target.value }))}
          placeholder="com.example.app — lets the loop relaunch and re-navigate"
          aria-label={`App id for ${target.label}`}
        />
      </label>
      <label className={styles.row}>
        <span className={styles.label}>Source dir</span>
        <TextField
          value={draft.sourceDir ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, sourceDir: e.target.value }))}
          placeholder="apps/tvos — what gets committed on accept"
          aria-label={`Source directory for ${target.label}`}
        />
      </label>
      {field("build", "Build", "xcodebuild -scheme App -destination 'platform=tvOS Simulator,…'")}
      {field("reload", "Reload", "faster than a build where the stack has it — used first when set")}
      {field("install", "Install", "xcrun simctl install booted build/App.app")}
      {field("test", "Test", "runs after the screen matches; a red suite holds the gate")}
      <p className={styles.hint}>
        Commands run through the shell from the project root. Leave a field empty and the loop asks
        the agent to do that step itself.
      </p>
      <div className={styles.actions}>
        {recipe ? (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            type="button"
            onClick={() => void removeRecipe(target.label).then(onClose)}
          >
            Remove
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" type="submit">
          Save recipe
        </Button>
      </div>
    </form>
  );
}
