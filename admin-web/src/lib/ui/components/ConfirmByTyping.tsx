import { useState } from "react";

/**
 * A shared type-to-confirm primitive: one controlled text input plus one
 * confirm button, disabled until the typed value exactly (case-sensitive)
 * matches `expected` — friction by design for irreversible actions.
 * Leading/trailing whitespace around an otherwise-correct value is ignored
 * (value.trim() === expected) so an accidental stray space doesn't block a
 * correct answer, but inner mismatches (case, missing/extra characters)
 * still block it.
 */
export function ConfirmByTyping({
  expected,
  confirmLabel,
  onConfirm,
  disabled = false,
}: {
  expected: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const matches = value.trim() === expected;

  return (
    <div className="ui-confirm-by-typing">
      <label className="ui-field-label">
        <span>{`Type "${expected}" to confirm`}</span>
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="ui-button ui-button-danger"
        disabled={!matches || disabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
