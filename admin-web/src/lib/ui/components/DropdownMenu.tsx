import { useEffect, useRef, useState, type ReactNode } from "react";

interface DropdownMenuProps {
  /** Content rendered inside the trigger button (label text, chevron, etc). */
  label: ReactNode;
  /** Accessible name for the trigger, when the visible label isn't descriptive enough on its own. */
  ariaLabel?: string;
  /** Extra classes appended to the trigger button, e.g. to match `ui-nav__link`. */
  triggerClassName?: string;
  /** Extra classes appended to the floating panel, e.g. to align it under the trigger's right edge. */
  panelClassName?: string;
  /** Menu content; receives `close` so item `onClick`/`onChange` handlers can dismiss the menu. */
  children: (close: () => void) => ReactNode;
}

/**
 * A reusable trigger+panel dropdown shared by the "History" nav submenu and
 * the "Account" menu. The panel unmounts entirely when closed (not just
 * hidden) to match how ContextPanel and other conditional panels in this
 * codebase already behave. Callers get a `close` function threaded into
 * their menu content so individual items can dismiss the menu on their own
 * terms (e.g. a select's onChange closing it, while a toggle inside stays
 * open across repeated clicks).
 */
export function DropdownMenu({ label, ariaLabel, triggerClassName, panelClassName, children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return undefined;

    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="ui-dropdown">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className={`ui-dropdown__trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className={`ui-dropdown__panel${panelClassName ? ` ${panelClassName}` : ""}`} role="menu">
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
