import type { PropsWithChildren, ReactNode } from "react";

interface AppShellProps extends PropsWithChildren {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  headerActions?: ReactNode;
  sidebar?: ReactNode;
  compact?: boolean;
}

export function AppShell({ eyebrow, title, subtitle, headerActions, sidebar, compact, children }: AppShellProps) {
  return (
    <div className={`ui-app-shell${compact ? " ui-app-shell--compact" : ""}`}>
      <section className="ui-hero-card">
        <div>
          {eyebrow ? <p className="ui-eyebrow">{eyebrow}</p> : null}
          <h1 className="ui-title">{title}</h1>
          {subtitle ? <p className="ui-subtitle">{subtitle}</p> : null}
        </div>
        {headerActions ? <div className="ui-actions">{headerActions}</div> : null}
      </section>
      <div className={`ui-frame${sidebar ? " ui-frame--with-sidebar" : ""}`}>
        {sidebar ? <aside className="ui-sidebar">{sidebar}</aside> : null}
        <main className="ui-main">{children}</main>
      </div>
    </div>
  );
}
