package syncapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/jackc/pgx/v5"
)

type replayStore struct {
	replayResult ReplayResult
	replayErr    error
	replayCall   struct {
		userID      string
		workspaceID string
		afterCursor int64
	}
}

func (f *replayStore) CreateFolder(context.Context, string, string, bookmarks.CreateFolderInput, Metadata) (MutationResult[bookmarks.Folder], error) {
	return MutationResult[bookmarks.Folder]{}, nil
}

func (f *replayStore) UpdateFolder(context.Context, string, string, bookmarks.UpdateFolderInput, Metadata) (MutationResult[bookmarks.Folder], error) {
	return MutationResult[bookmarks.Folder]{}, nil
}

func (f *replayStore) DeleteFolder(context.Context, string, string, Metadata) (DeleteResult, error) {
	return DeleteResult{}, nil
}

func (f *replayStore) CreateBookmark(context.Context, string, string, bookmarks.CreateBookmarkInput, Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return MutationResult[bookmarks.Bookmark]{}, nil
}

func (f *replayStore) UpdateBookmark(context.Context, string, string, bookmarks.UpdateBookmarkInput, Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return MutationResult[bookmarks.Bookmark]{}, nil
}

func (f *replayStore) PrepareFolderPatchTx(context.Context, pgx.Tx, string, string, bookmarks.UpdateFolderInput) (bookmarks.PreparedFolderPatch, error) {
	return bookmarks.PreparedFolderPatch{}, nil
}

func (f *replayStore) ApplyPreparedFolderPatchTx(context.Context, pgx.Tx, string, bookmarks.PreparedFolderPatch, Metadata) (PreparedMutationResult[bookmarks.Folder], error) {
	return PreparedMutationResult[bookmarks.Folder]{}, nil
}

func (f *replayStore) ApplyPreparedBookmarkPatchTx(context.Context, pgx.Tx, string, bookmarks.PreparedBookmarkPatch, Metadata) (PreparedMutationResult[bookmarks.Bookmark], error) {
	return PreparedMutationResult[bookmarks.Bookmark]{}, nil
}

func (f *replayStore) DeleteBookmark(context.Context, string, string, Metadata) (DeleteResult, error) {
	return DeleteResult{}, nil
}

func (f *replayStore) ReplayEvents(_ context.Context, userID, workspaceID string, afterCursor int64) (ReplayResult, error) {
	f.replayCall.userID = userID
	f.replayCall.workspaceID = workspaceID
	f.replayCall.afterCursor = afterCursor
	return f.replayResult, f.replayErr
}

func (f *replayStore) CurrentCursor(context.Context, string) (int64, error) {
	return 0, nil
}

func TestRegisterRoutesReplayResponses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		url        string
		store      *replayStore
		wantStatus int
		wantCall   bool
		assertBody func(*testing.T, *httptest.ResponseRecorder)
	}{
		{
			name: "returns replay payload",
			url:  "/sync/events?workspaceId=workspace-1&afterCursor=12",
			store: &replayStore{replayResult: ReplayResult{
				CurrentCursor: 14,
				Events:        []Envelope{{Cursor: 13, EventID: "evt-13"}, {Cursor: 14, EventID: "evt-14"}},
			}},
			wantStatus: http.StatusOK,
			wantCall:   true,
			assertBody: func(t *testing.T, res *httptest.ResponseRecorder) {
				t.Helper()

				var body ReplayResult
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatalf("decode response: %v", err)
				}
				if body.CurrentCursor != 14 {
					t.Fatalf("currentCursor = %d, want 14", body.CurrentCursor)
				}
				if len(body.Events) != 2 || body.Events[0].Cursor != 13 || body.Events[1].Cursor != 14 {
					t.Fatalf("events = %#v, want cursors [13 14]", body.Events)
				}
				if body.ResyncRequired {
					t.Fatal("resyncRequired = true, want false")
				}
			},
		},
		{
			name: "returns resync conflict",
			url:  "/sync/events?workspaceId=workspace-1&afterCursor=12",
			store: &replayStore{
				replayResult: ReplayResult{CurrentCursor: 25, ResyncRequired: true},
				replayErr:    ErrResyncRequired,
			},
			wantStatus: http.StatusConflict,
			wantCall:   true,
			assertBody: func(t *testing.T, res *httptest.ResponseRecorder) {
				t.Helper()

				var body ReplayResult
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatalf("decode response: %v", err)
				}
				if body.CurrentCursor != 25 || !body.ResyncRequired {
					t.Fatalf("body = %#v, want currentCursor=25 resyncRequired=true", body)
				}
			},
		},
		{
			name: "returns forbidden when workspace access is denied",
			url:  "/sync/events?workspaceId=workspace-1&afterCursor=12",
			store: &replayStore{
				replayErr: workspaces.ErrForbidden,
			},
			wantStatus: http.StatusForbidden,
			wantCall:   true,
			assertBody: func(t *testing.T, res *httptest.ResponseRecorder) {
				t.Helper()

				var body map[string]string
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatalf("decode response: %v", err)
				}
				if body["error"] != workspaces.ErrForbidden.Error() {
					t.Fatalf("error = %q, want %q", body["error"], workspaces.ErrForbidden.Error())
				}
			},
		},
		{
			name:       "rejects invalid cursor before store call",
			url:        "/sync/events?workspaceId=workspace-1&afterCursor=-1",
			store:      &replayStore{},
			wantStatus: http.StatusBadRequest,
			wantCall:   false,
			assertBody: func(t *testing.T, res *httptest.ResponseRecorder) {
				t.Helper()

				var body map[string]string
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatalf("decode response: %v", err)
				}
				if body["error"] != "afterCursor must be zero or greater" {
					t.Fatalf("error = %q, want %q", body["error"], "afterCursor must be zero or greater")
				}
			},
		},
	}

	for _, tt := range tests {
		tc := tt
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			service := NewService(tc.store)
			mux := http.NewServeMux()
			authMiddleware := func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					principal := auth.Principal{UserID: "user-1", ClientID: "client-1"}
					next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal)))
				})
			}
			RegisterRoutes(mux, authMiddleware, service)

			req := httptest.NewRequest(http.MethodGet, tc.url, nil)
			res := httptest.NewRecorder()

			mux.ServeHTTP(res, req)

			if res.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", res.Code, tc.wantStatus)
			}
			tc.assertBody(t, res)

			if tc.wantCall {
				if tc.store.replayCall.userID != "user-1" || tc.store.replayCall.workspaceID != "workspace-1" || tc.store.replayCall.afterCursor != 12 {
					t.Fatalf("unexpected replay call = %#v", tc.store.replayCall)
				}
			} else if tc.store.replayCall.workspaceID != "" {
				t.Fatalf("store should not be called for invalid cursor, got %#v", tc.store.replayCall)
			}
		})
	}
}
