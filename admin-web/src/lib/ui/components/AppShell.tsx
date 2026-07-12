import type { PropsWithChildren, ReactNode } from "react";

interface AppShellProps extends PropsWithChildren {
  context?: ReactNode;
  compact?: boolean;
}

export function AppShell({ context, compact, children }: AppShellProps) {
  return (
    <div className={`ui-app-shell${compact ? " ui-app-shell--compact" : ""}`}>
      {context ? <header className="ui-context-bar">{context}</header> : null}
      <main className="ui-main">{children}</main>
    </div>
  );
}
