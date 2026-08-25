import type { FolderNode } from "../../lib/api/bookmarks";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import type { ImportRunner } from "./useImportRunner";

interface FolderOption {
  id: string;
  label: string;
}

function folderOptions(folders: FolderNode[], depth = 0): FolderOption[] {
  const options: FolderOption[] = [];
  for (const folder of [...folders].sort((a, b) => a.position - b.position)) {
    options.push({ id: folder.id, label: `${"— ".repeat(depth)}${folder.name}` });
    options.push(...folderOptions(folder.folders, depth + 1));
  }
  return options;
}

// File input, destination picker, the two pre-flight checks (500-node
// ceiling / Decision 17 root-bookmark refusal), preview, failure list, and
// "Retry failed items" — all driven by the page-level useImportRunner()
// (design.md Phase D3 / Decision 19).
export function ImportPanel({ runner, folders }: { runner: ImportRunner; folders: FolderNode[] }) {
  if (runner.parseError) {
    return (
      <div className="ui-section-stack">
        <DataState compact tone="danger" title="File could not be parsed" description={runner.parseError} />
        <div className="ui-actions-row">
          <button className="ui-button ui-button-secondary" type="button" onClick={() => runner.reset()}>
            Choose a different file
          </button>
        </div>
      </div>
    );
  }

  if (runner.status === "idle") {
    return (
      <div className="ui-form ui-section-stack">
        <FormRow label="Bookmarks file" hint="A Netscape-format bookmarks.html export from a browser.">
          <input
            aria-label="Bookmarks file"
            type="file"
            accept=".html,text/html"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void runner.loadFile(file);
              }
            }}
          />
        </FormRow>
      </div>
    );
  }

  const options = folderOptions(folders);
  const parseResult = runner.parseResult;

  return (
    <div className="ui-section-stack">
      <p className="ui-copy">{`${runner.fileName} — ${parseResult?.nodeCount ?? 0} items parsed.`}</p>
      {parseResult && parseResult.skipped.length > 0 ? (
        <p className="ui-muted">{`${parseResult.skipped.length} link${parseResult.skipped.length === 1 ? "" : "s"} skipped (unsupported link type).`}</p>
      ) : null}

      <FormRow label="Import destination">
        <select aria-label="Import destination" value={runner.destinationFolderId ?? ""} disabled={runner.isRunning} onChange={(event) => runner.setDestination(event.target.value || null)}>
          <option value="">Workspace root</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </FormRow>

      {runner.blockReason ? <DataState compact tone="danger" title="Import blocked" description={runner.blockReason} /> : null}
      {runner.runError ? <DataState compact tone="danger" title="Import failed to run" description={runner.runError} /> : null}

      <div>
        <h3 className="ui-section-title">Preview</h3>
        <ul aria-label="Import preview" className="ui-import-preview">
          {runner.plan.map((item) => (
            <li key={item.key}>{item.kind === "folder" ? item.label : `${item.label} — ${item.url}`}</li>
          ))}
        </ul>
      </div>

      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" type="button" disabled={Boolean(runner.blockReason) || runner.isRunning || runner.status === "done"} onClick={() => runner.confirmImport()}>
          {runner.isRunning ? "Importing…" : "Start import"}
        </button>
      </div>

      {runner.status === "done" ? <p className="ui-copy" role="status">{`Imported ${runner.completed} of ${runner.total} items.`}</p> : null}

      {runner.failures.length > 0 ? (
        <div className="ui-section-stack">
          <h3 className="ui-section-title">Failed items</h3>
          <ul aria-label="Failed items">
            {runner.failures.map((failure) => (
              <li key={failure.key}>{`${failure.label} — ${failure.reason}`}</li>
            ))}
          </ul>
          <div className="ui-actions-row">
            <button className="ui-button ui-button-secondary" type="button" disabled={runner.isRunning} onClick={() => runner.retryFailedItems()}>
              Retry failed items
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
