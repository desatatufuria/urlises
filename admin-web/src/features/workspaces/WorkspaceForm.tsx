import { useState, type FormEvent } from "react";
import { FormRow } from "../../lib/ui/components/FormRow";

// Every workspace is created as type "shared" — it's the only value ever
// read or branched on anywhere in the backend or extension, so exposing it
// as an editable field just added an unhelpful decision with no real
// options behind it ("Use the backend-supported type label..." implied a
// validated set that doesn't exist). Kept as a fixed constant, not a UI
// choice, until a second real workspace type actually exists.
const WORKSPACE_TYPE = "shared";

export function WorkspaceForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (input: { name: string; type: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ name: name.trim(), type: WORKSPACE_TYPE });
    setName("");
  };

  return (
    <form className="ui-form ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <FormRow label="Workspace name" hint="Keep the name task-oriented so access reviews stay readable.">
        <input aria-label="Workspace name" required value={name} onChange={(event) => setName(event.target.value)} />
      </FormRow>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
          {submitting ? "Creating workspace…" : "Create workspace"}
        </button>
      </div>
    </form>
  );
}
