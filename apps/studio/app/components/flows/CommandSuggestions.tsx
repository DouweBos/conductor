import { Button, EmptyState, Icon, StatusPill } from "@conductor/studio-ui";
import { useMemo } from "react";

import { commandSuggestions, describeElement } from "../../lib/commandSuggestions";
import { getCurrentRoute } from "../../lib/router";
import type { CaptureUiResult, Platform } from "../../lib/types";
import { appendToBuffer } from "../../stores/flowStore";
import { findElement, setSelectedRef, useSelectedRef } from "../../stores/inspectStore";
import styles from "./CommandSuggestions.module.css";

/**
 * The commands that fit the element you picked on the device — pick one and it
 * lands in the open flow. This is the point of inspect mode: you click a button
 * on screen and get `tapOn`/`assertVisible`/… written for you.
 */
export function CommandSuggestions({
  capture,
  platform,
}: {
  capture: CaptureUiResult;
  platform: Platform;
}) {
  const selectedRef = useSelectedRef();
  const element = selectedRef ? findElement(capture.root, selectedRef) : null;
  const suggestions = useMemo(
    () => (element ? commandSuggestions(element, capture, platform) : []),
    [element, capture, platform],
  );

  if (!element) {
    return (
      <EmptyState
        icon="search"
        title="Pick an element"
        description="Hover the device to outline elements, then click one to see the commands that fit it."
      />
    );
  }

  const flowPath = getCurrentRoute().flowPath;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.name}>{describeElement(element)}</span>
        {element.role ? <StatusPill tone="neutral">{element.role}</StatusPill> : null}
        <div className={styles.spacer} />
        <button
          type="button"
          className={styles.close}
          onClick={() => setSelectedRef(null)}
          aria-label="Clear selection"
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      {!flowPath ? (
        <div className={styles.hint}>Open a flow to insert these commands into it.</div>
      ) : null}
      <ul className={styles.list}>
        {suggestions.map((s) => (
          <li key={s.title} className={styles.item}>
            <div className={styles.itemHead}>
              <span className={styles.title}>{s.title}</span>
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                disabled={!flowPath}
                onClick={() => flowPath && appendToBuffer(flowPath, s.content)}
              >
                Insert
              </Button>
            </div>
            <pre className={styles.code}>{s.content}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
