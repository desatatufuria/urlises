import type { ActivityCategory } from "../../lib/api/activity";

interface ActivityCategoryToggleProps {
  category: ActivityCategory;
  onChange: (category: ActivityCategory) => void;
}

const OPTIONS: { value: ActivityCategory; label: string }[] = [
  { value: "all", label: "All" },
  { value: "administrative", label: "Administrative" },
  { value: "bookmarks", label: "Bookmarks" },
];

/**
 * A 3-way segmented control for filtering the activity feed by category.
 * Text labels, not icons: unlike ThemeToggle (icon-only, tight header bar),
 * these three categories have no obvious glyphs and this control sits above
 * a full-width table where text labels read fine.
 */
export function ActivityCategoryToggle({ category, onChange }: ActivityCategoryToggleProps) {
  return (
    <div role="group" aria-label="Activity category" className="ui-segmented">
      {OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={`ui-segmented__button${category === value ? " ui-segmented__button--active" : ""}`}
          aria-pressed={category === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
