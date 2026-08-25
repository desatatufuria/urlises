import { useCallback, useReducer } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createBookmark, createFolder } from "../../lib/api/bookmarks";
import { queryKeys } from "../../lib/api/queryKeys";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";
import { BookmarkParseError, parseNetscapeBookmarks, type ParseResult } from "../../lib/bookmarks/parseNetscapeBookmarks";
import { IMPORT_NODE_CEILING, ImportCeilingError, retryFailedPlan, runImportPlan, toImportPlan, type ImportFailure, type ImportItem } from "../../lib/bookmarks/importPlan";

// Reducer state + sequential run loop (design.md Phase D3 / Decision 19).
// Mounted at BookmarksPage level, NOT inside ImportPanel: ContextPanel
// unmounts entirely when `?panel=` is cleared, so panel-owned state would
// kill an in-flight import the moment the admin closes the modal to look
// at the tree. This hook survives that unmount/remount.
interface State {
  status: "idle" | "parsed" | "running" | "done";
  fileName: string | null;
  parseError: string | null;
  parseResult: ParseResult | null;
  plan: ImportItem[];
  destinationFolderId: string | null; // null = workspace root
  createdIds: Record<string, string>;
  failures: ImportFailure[];
  completed: number;
  total: number;
  currentKey: string | null;
  runError: string | null;
}

const initialState: State = {
  status: "idle",
  fileName: null,
  parseError: null,
  parseResult: null,
  plan: [],
  destinationFolderId: null,
  createdIds: {},
  failures: [],
  completed: 0,
  total: 0,
  currentKey: null,
  runError: null,
};

type Action =
  | { type: "file-parsed"; fileName: string; parseResult: ParseResult; plan: ImportItem[] }
  | { type: "file-error"; message: string }
  | { type: "set-destination"; destinationFolderId: string | null }
  | { type: "run-start" }
  | { type: "progress"; completed: number; total: number; currentKey: string | null }
  | { type: "run-done"; createdIds: Record<string, string>; failures: ImportFailure[] }
  | { type: "run-error"; message: string }
  | { type: "reset" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "file-parsed":
      return {
        ...initialState,
        status: "parsed",
        fileName: action.fileName,
        parseResult: action.parseResult,
        plan: action.plan,
      };
    case "file-error":
      return { ...initialState, parseError: action.message };
    case "set-destination":
      return { ...state, destinationFolderId: action.destinationFolderId };
    case "run-start":
      return { ...state, status: "running", runError: null, completed: 0, total: state.plan.length, currentKey: null };
    case "progress":
      return { ...state, completed: action.completed, total: action.total, currentKey: action.currentKey };
    case "run-done":
      return { ...state, status: "done", createdIds: action.createdIds, failures: action.failures, currentKey: null };
    case "run-error":
      return { ...state, status: "done", runError: action.message, currentKey: null };
    case "reset":
      return initialState;
    default:
      return state;
  }
}

/**
 * Decision 17 pre-flight check: a bookmark can never live at the workspace
 * root, so if the destination IS the root and the file has top-level
 * bookmarks, importing is blocked before any call — never a silent drop,
 * never an invented container folder.
 */
function rootBookmarkBlockReason(state: State): string | null {
  if (state.destinationFolderId !== null) return null;
  const count = state.parseResult?.topLevelBookmarkCount ?? 0;
  if (count === 0) return null;
  return `${count} bookmark${count === 1 ? "" : "s"} sit at the top level of this file. A bookmark cannot live at the workspace root — choose a destination folder.`;
}

export function useImportRunner(token?: string, workspaceId?: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();
  const retry = useUncertainCreationKey();

  const loadFile = useCallback(async (file: File) => {
    try {
      // jsdom's File/Blob implementation (this repo's test harness) does
      // not implement `Blob.text()`, so this reads via FileReader instead
      // — a real browser supports both, but only this path is portable.
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("File could not be read."));
        reader.readAsText(file);
      });
      const parseResult = parseNetscapeBookmarks(text);
      const plan = toImportPlan(parseResult.roots);
      dispatch({ type: "file-parsed", fileName: file.name, parseResult, plan });
    } catch (error) {
      dispatch({ type: "file-error", message: error instanceof BookmarkParseError ? error.message : "This file could not be parsed." });
    }
  }, []);

  const setDestination = useCallback((destinationFolderId: string | null) => {
    dispatch({ type: "set-destination", destinationFolderId });
  }, []);

  const runPlan = useCallback(
    async (plan: ImportItem[], createdIds: Record<string, string>) => {
      dispatch({ type: "run-start" });
      try {
        const result = await runImportPlan({
          plan,
          destinationFolderId: state.destinationFolderId,
          createdIds,
          create: {
            createFolder: async (parentId, item) => {
              const syncEventId = retry.keyFor({ nodeKey: item.key });
              try {
                const resource = await createFolder(token!, workspaceId!, { parentId, name: item.label }, syncEventId);
                retry.confirm({ nodeKey: item.key });
                return resource.id;
              } catch (error) {
                retry.retainAfterFailure({ nodeKey: item.key }, error);
                throw error;
              }
            },
            createBookmark: async (parentId, item) => {
              const syncEventId = retry.keyFor({ nodeKey: item.key });
              try {
                const resource = await createBookmark(token!, workspaceId!, { folderId: parentId, title: item.label, url: item.url! }, syncEventId);
                retry.confirm({ nodeKey: item.key });
                return resource.id;
              } catch (error) {
                retry.retainAfterFailure({ nodeKey: item.key }, error);
                throw error;
              }
            },
          },
          onProgress: (completed, total, currentKey) => dispatch({ type: "progress", completed, total, currentKey }),
        });
        dispatch({ type: "run-done", createdIds: result.createdIds, failures: result.failures });
      } catch (error) {
        dispatch({
          type: "run-error",
          message: error instanceof ImportCeilingError ? error.message : error instanceof Error ? error.message : "The import could not run.",
        });
      } finally {
        if (workspaceId) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).tree });
        }
      }
    },
    [state.destinationFolderId, retry, token, workspaceId, queryClient],
  );

  const confirmImport = useCallback(() => {
    void runPlan(state.plan, {});
  }, [runPlan, state.plan]);

  const retryFailedItems = useCallback(() => {
    const retryPlan = retryFailedPlan(state.plan, state.failures);
    void runPlan(retryPlan, state.createdIds);
  }, [runPlan, state.plan, state.failures, state.createdIds]);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const blockReason = state.parseResult && state.plan.length > IMPORT_NODE_CEILING ? new ImportCeilingError(state.plan.length).message : rootBookmarkBlockReason(state);

  return {
    status: state.status,
    fileName: state.fileName,
    parseError: state.parseError,
    parseResult: state.parseResult,
    plan: state.plan,
    destinationFolderId: state.destinationFolderId,
    createdIds: state.createdIds,
    failures: state.failures,
    completed: state.completed,
    total: state.total,
    currentKey: state.currentKey,
    runError: state.runError,
    blockReason,
    isRunning: state.status === "running",
    hasFailures: state.failures.length > 0,
    loadFile,
    setDestination,
    confirmImport,
    retryFailedItems,
    reset,
  };
}

export type ImportRunner = ReturnType<typeof useImportRunner>;
