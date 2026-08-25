import { useState, type FormEvent } from "react";
import { FormRow } from "../../lib/ui/components/FormRow";

// Title + URL fields, shared by create and edit (design.md B2.6). Both
// fields are required and edited together — the proposal explicitly
// rejected a title-only edit because it would leave a broken URL
// permanently uneditable.
export function BookmarkForm({
  initialTitle = "",
  initialUrl = "",
  submitting,
  submitLabel,
  onSubmit,
}: {
  initialTitle?: string;
  initialUrl?: string;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (input: { title: string; url: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState(initialUrl);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ title: title.trim(), url: url.trim() });
  };

  return (
    <form className="ui-form ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <FormRow label="Bookmark title">
        <input aria-label="Bookmark title" required value={title} onChange={(event) => setTitle(event.target.value)} />
      </FormRow>
      <FormRow label="Bookmark URL">
        <input aria-label="Bookmark URL" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} />
      </FormRow>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
          {submitting ? `${submitLabel}…` : submitLabel}
        </button>
      </div>
    </form>
  );
}
