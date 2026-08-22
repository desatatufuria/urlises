import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceRole } from "../../lib/api/types";
import { FormRow } from "../../lib/ui/components/FormRow";
import { DataState } from "../../lib/ui/components/DataState";

const roleOptions: WorkspaceRole[] = ["admin", "editor", "viewer"];

type SubjectType = "user" | "group";

const roleLegend = "Viewer can browse bookmarks. Editor can also add and edit them. Admin can also manage who has access.";

export function AccessGrantForm({
  userOptions,
  groupOptions,
  submittingUser,
  submittingGroup,
  onSubmitUser,
  onSubmitGroup,
}: {
  userOptions: Array<{ value: string; label: string }>;
  groupOptions: Array<{ value: string; label: string }>;
  submittingUser: boolean;
  submittingGroup: boolean;
  onSubmitUser: (input: { subjectId: string; role: WorkspaceRole }) => Promise<void>;
  onSubmitGroup: (input: { subjectId: string; role: WorkspaceRole }) => Promise<void>;
}) {
  const [subjectType, setSubjectType] = useState<SubjectType>("user");
  const [subjectId, setSubjectId] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");

  const options = subjectType === "user" ? userOptions : groupOptions;
  const subjectLabel = subjectType === "user" ? "Organization member" : "Group";
  const submitting = subjectType === "user" ? submittingUser : submittingGroup;
  const hasOptions = options.length > 0;

  useEffect(() => {
    setSubjectId(options[0]?.value ?? "");
  }, [options]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!subjectId) {
      return;
    }

    if (subjectType === "user") {
      await onSubmitUser({ subjectId, role });
    } else {
      await onSubmitGroup({ subjectId, role });
    }
    setRole("viewer");
  };

  return (
    <form className="ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <header className="ui-section-header">
        <h3 className="ui-section-title">Grant workspace access</h3>
        <p className="ui-copy">
          Grant access to one person directly, or to an entire group at once. Group grants update automatically as
          group membership changes; direct grants are easier to audit individually.
        </p>
      </header>

      <div className="ui-actions-row" role="group" aria-label="Grant target type">
        <button
          className={subjectType === "user" ? "ui-button ui-button-primary" : "ui-button ui-button-secondary"}
          type="button"
          aria-pressed={subjectType === "user"}
          onClick={() => setSubjectType("user")}
        >
          Person
        </button>
        <button
          className={subjectType === "group" ? "ui-button ui-button-primary" : "ui-button ui-button-secondary"}
          type="button"
          aria-pressed={subjectType === "group"}
          onClick={() => setSubjectType("group")}
        >
          Group
        </button>
      </div>

      {hasOptions ? (
        <div className="ui-inline-grid">
          <FormRow label={subjectLabel}>
            <select aria-label={subjectLabel} disabled={submitting} value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label={`${subjectLabel} role`} hint={roleLegend}>
            <select aria-label={`${subjectLabel} role`} value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
              {roleOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </FormRow>
        </div>
      ) : (
        <DataState
          compact
          title={subjectType === "user" ? "Everyone already has a direct grant" : "Every group already has a grant"}
          description={
            subjectType === "user"
              ? "All organization members already have a direct grant to this workspace."
              : "All groups already have a workspace grant."
          }
        />
      )}

      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting || !subjectId || !hasOptions} type="submit">
          {submitting ? "Granting access…" : "Grant access"}
        </button>
      </div>
    </form>
  );
}
