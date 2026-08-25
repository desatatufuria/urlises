import { useState, type FormEvent } from "react";
import { FormRow } from "../../lib/ui/components/FormRow";

// Name field, shared by create and rename (design.md B2.5) — the only
// difference between the two uses is whether `initialName` is populated.
export function FolderForm({
  initialName = "",
  submitting,
  submitLabel,
  onSubmit,
}: {
  initialName?: string;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (input: { name: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ name: name.trim() });
  };

  return (
    <form className="ui-form ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <FormRow label="Folder name">
        <input aria-label="Folder name" required value={name} onChange={(event) => setName(event.target.value)} />
      </FormRow>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
          {submitting ? `${submitLabel}…` : submitLabel}
        </button>
      </div>
    </form>
  );
}
