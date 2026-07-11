import type { PropsWithChildren } from "react";

export function FormRow({ label, hint, children }: PropsWithChildren<{ label?: string; hint?: string }>) {
  return (
    <label className="ui-field-label">
      {label ? <span>{label}</span> : null}
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
