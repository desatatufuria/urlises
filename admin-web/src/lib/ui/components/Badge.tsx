import type { PropsWithChildren } from "react";

export function Badge({ tone = "neutral", children }: PropsWithChildren<{ tone?: "neutral" | "accent" | "danger" }>) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}
