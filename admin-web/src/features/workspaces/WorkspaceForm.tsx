import { useState, type FormEvent } from "react";
import { FormRow } from "../../lib/ui/components/FormRow";

export function WorkspaceForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (input: { name: string; type: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("shared");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ name: name.trim(), type: type.trim() });
    setName("");
    setType("shared");
  };

  return (
    <form className="ui-form ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <div className="ui-inline-grid">
        <FormRow label="Workspace name" hint="Keep the name task-oriented so access reviews stay readable.">
          <input aria-label="Workspace name" required value={name} onChange={(event) => setName(event.target.value)} />
        </FormRow>
        <FormRow label="Workspace type" hint="Use the backend-supported type label that matches the operational intent.">
          <input aria-label="Workspace type" required value={type} onChange={(event) => setType(event.target.value)} />
        </FormRow>
      </div>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
          {submitting ? "Creating workspace…" : "Create workspace"}
        </button>
      </div>
    </form>
  );
}
