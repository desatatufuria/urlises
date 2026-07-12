import { useEffect, useId, useRef, type PropsWithChildren } from "react";

export function ContextPanel({ title, onClose, children }: PropsWithChildren<{ title: string; onClose: () => void }>) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []).filter((element) => element.tabIndex >= 0);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="ui-panel-backdrop" role="presentation" onMouseDown={onClose}>
      <aside ref={panelRef} aria-labelledby={titleId} aria-modal="true" className="ui-context-panel" role="dialog" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="ui-panel-header">
          <h2 id={titleId} className="ui-section-title">{title}</h2>
          <button ref={closeButtonRef} aria-label="Close panel" className="ui-panel-close" type="button" onClick={onClose}>Close</button>
        </header>
        <div className="ui-panel-body">{children}</div>
      </aside>
    </div>
  );
}
