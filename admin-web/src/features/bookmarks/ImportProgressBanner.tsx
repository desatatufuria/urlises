import type { ImportRunner } from "./useImportRunner";

// completed/total, failure count, link back to the import panel. Rendered
// by BookmarksPage whenever a run is active or has left failures behind —
// this is what keeps an in-flight or just-finished import visible even
// after the ImportPanel's ContextPanel has been closed (design.md
// Decision 19: the run survives the panel's unmount).
export function ImportProgressBanner({ runner, onOpenPanel }: { runner: ImportRunner; onOpenPanel: () => void }) {
  const visible = runner.isRunning || runner.status === "done";
  if (!visible) {
    return null;
  }

  const description = runner.isRunning
    ? `Importing… ${runner.completed} of ${runner.total} items created so far.`
    : runner.runError
      ? runner.runError
      : `Import finished: ${runner.completed} of ${runner.total} items created${runner.failures.length > 0 ? `, ${runner.failures.length} failed` : ""}.`;

  return (
    <div className="ui-data-state ui-data-state--compact" role="status">
      <p className="ui-copy">{description}</p>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-secondary" type="button" onClick={onOpenPanel}>
          {runner.failures.length > 0 ? "View failed items" : "View import"}
        </button>
      </div>
    </div>
  );
}
