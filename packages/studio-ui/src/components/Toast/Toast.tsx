import { Icon, type IconName } from "../../icons/Icons";
import styles from "./Toast.module.css";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastData {
  id: string;
  tone?: ToastTone;
  title: string;
  message?: string;
}

const ICONS: Record<ToastTone, IconName> = {
  info: "dot",
  success: "check",
  warning: "alert",
  error: "alert",
};

export interface ToastViewportProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div className={styles.viewport} role="region" aria-label="Notifications">
      {toasts.map((toast) => {
        const tone = toast.tone ?? "info";
        return (
          <div key={toast.id} className={[styles.toast, styles[tone]].join(" ")} role="status">
            <Icon name={ICONS[tone]} size={16} className={styles.icon} />
            <div className={styles.content}>
              <div className={styles.title}>{toast.title}</div>
              {toast.message ? <div className={styles.message}>{toast.message}</div> : null}
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label="Dismiss"
              onClick={() => onDismiss(toast.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
