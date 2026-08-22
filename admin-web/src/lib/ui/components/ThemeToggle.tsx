import type { ColorSchemePreference } from "../colorScheme";

interface ThemeToggleProps {
  preference: ColorSchemePreference;
  onChange: (preference: ColorSchemePreference) => void;
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z" strokeLinejoin="round" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11v3" strokeLinecap="round" />
    </svg>
  );
}

const OPTIONS: { value: ColorSchemePreference; label: string; icon: () => JSX.Element }[] = [
  { value: "system", label: "Match system theme", icon: MonitorIcon },
  { value: "light", label: "Light theme", icon: SunIcon },
  { value: "dark", label: "Dark theme", icon: MoonIcon },
];

/**
 * A compact 3-button segmented control replacing the old color-scheme
 * <select>. Kept as plain inline SVGs (sun/moon/monitor) since this
 * codebase has no icon library and the control sits in a tight header bar.
 */
export function ThemeToggle({ preference, onChange }: ThemeToggleProps) {
  return (
    <div role="group" aria-label="Color scheme" className="ui-segmented">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={`ui-segmented__button${preference === value ? " ui-segmented__button--active" : ""}`}
          aria-pressed={preference === value}
          aria-label={label}
          onClick={() => onChange(value)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
