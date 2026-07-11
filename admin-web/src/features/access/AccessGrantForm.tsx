import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceRole } from "../../lib/api/types";
import { FormRow } from "../../lib/ui/components/FormRow";

const roleOptions: WorkspaceRole[] = ["admin", "editor", "viewer"];

export function AccessGrantForm({
  title,
  subjectLabel,
  emptyLabel,
  options,
  submitting,
  onSubmit,
}: {
  title: string;
  subjectLabel: string;
  emptyLabel: string;
  options: Array<{ value: string; label: string }>;
  submitting: boolean;
  onSubmit: (input: { subjectId: string; role: WorkspaceRole }) => Promise<void>;
}) {
  const [subjectId, setSubjectId] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");

  useEffect(() => {
    setSubjectId(options[0]?.value ?? "");
  }, [options]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!subjectId) {
      return;
    }

    await onSubmit({ subjectId, role });
    setRole("viewer");
  };

  return (
    <form className="ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <header className="ui-section-header">
        <h3 className="ui-section-title">{title}</h3>
        <p className="ui-copy">Grants stay explicit per workspace so reviewers can inspect the direct source before trusting the effective result.</p>
      </header>

      <div className="ui-inline-grid">
        <FormRow label={subjectLabel}>
          <select aria-label={subjectLabel} disabled={submitting || options.length === 0} value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
            {options.length === 0 ? <option value="">{emptyLabel}</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Role">
          <select aria-label={`${subjectLabel} role`} value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </FormRow>
      </div>

      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting || !subjectId} type="submit">
          {submitting ? "Saving grant…" : "Save grant"}
        </button>
      </div>
    </form>
  );
}
