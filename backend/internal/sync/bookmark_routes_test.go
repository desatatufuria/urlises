package syncapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/jackc/pgx/v5"
)

type fakeStore struct {
	createBookmarkResult MutationResult[bookmarks.Bookmark]
	createBookmarkErr    error
	createBookmarkMeta   Metadata
	createBookmarkInput  bookmarks.CreateBookmarkInput
	createWorkspaceID    string
	createUserID         string
	mutationCount        int
	duplicateByEventID   map[string]MutationResult[bookmarks.Bookmark]
}

func (f *fakeStore) CreateFolder(context.Context, string, string, bookmarks.CreateFolderInput, Metadata) (MutationResult[bookmarks.Folder], error) {
	return MutationResult[bookmarks.Folder]{}, nil
}
func (f *fakeStore) UpdateFolder(context.Context, string, string, bookmarks.UpdateFolderInput, Metadata) (MutationResult[bookmarks.Folder], error) {
	return MutationResult[bookmarks.Folder]{}, nil
}
func (f *fakeStore) DeleteFolder(context.Context, string, string, Metadata) (DeleteResult, error) {
	return DeleteResult{}, nil
}
func (f *fakeStore) CreateBookmark(_ context.Context, userID, workspaceID string, input bookmarks.CreateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error) {
	f.createUserID = userID
	f.createWorkspaceID = workspaceID
	f.createBookmarkInput = input
	f.createBookmarkMeta = metadata
	if f.createBookmarkErr != nil {
		return MutationResult[bookmarks.Bookmark]{}, f.createBookmarkErr
	}
	if f.duplicateByEventID != nil {
		key := workspaceID + ":" + metadata.EventID
		if existing, ok := f.duplicateByEventID[key]; ok {
			existing.Duplicate = true
			return existing, nil
		}

		f.mutationCount++
		result := MutationResult[bookmarks.Bookmark]{
			Resource: bookmarks.Bookmark{
				ID:          "bookmark-" + strconv.Itoa(f.mutationCount),
				WorkspaceID: workspaceID,
				FolderID:    input.FolderID,
				Title:       input.Title,
				URL:         input.URL,
				Position:    f.mutationCount,
			},
			Event: Envelope{EventID: metadata.EventID, Cursor: int64(40 + f.mutationCount)},
		}
		f.duplicateByEventID[key] = result
		return result, nil
	}
	return f.createBookmarkResult, nil
}
func (f *fakeStore) UpdateBookmark(context.Context, string, string, bookmarks.UpdateBookmarkInput, Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return MutationResult[bookmarks.Bookmark]{}, nil
}
func (f *fakeStore) PrepareFolderPatchTx(context.Context, pgx.Tx, string, string, bookmarks.UpdateFolderInput) (bookmarks.PreparedFolderPatch, error) {
	return bookmarks.PreparedFolderPatch{}, nil
}
func (f *fakeStore) ApplyPreparedFolderPatchTx(context.Context, pgx.Tx, string, bookmarks.PreparedFolderPatch, Metadata) (PreparedMutationResult[bookmarks.Folder], error) {
	return PreparedMutationResult[bookmarks.Folder]{}, nil
}
func (f *fakeStore) ApplyPreparedBookmarkPatchTx(context.Context, pgx.Tx, string, bookmarks.PreparedBookmarkPatch, Metadata) (PreparedMutationResult[bookmarks.Bookmark], error) {
	return PreparedMutationResult[bookmarks.Bookmark]{}, nil
}
func (f *fakeStore) DeleteBookmark(context.Context, string, string, Metadata) (DeleteResult, error) {
	return DeleteResult{}, nil
}
func (f *fakeStore) ReplayEvents(context.Context, string, string, int64) (ReplayResult, error) {
	return ReplayResult{}, nil
}
func (f *fakeStore) CurrentCursor(context.Context, string) (int64, error) {
	return 0, nil
}

func TestRegisterBookmarkRoutesReturnsDuplicateAckHeaders(t *testing.T) {
	t.Parallel()

	store := &fakeStore{createBookmarkResult: MutationResult[bookmarks.Bookmark]{
		Resource:  bookmarks.Bookmark{ID: "bookmark-1", WorkspaceID: "workspace-1", FolderID: "folder-1", Title: "Docs", URL: "https://example.com", Position: 1},
		Event:     Envelope{EventID: "evt-123", Cursor: 44},
		Duplicate: true,
	}}
	service := NewService(store)
	mux := http.NewServeMux()
	authMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal := auth.Principal{UserID: "user-1", ClientID: "client-1"}
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal)))
		})
	}
	RegisterBookmarkRoutes(mux, authMiddleware, service, nil)

	body := strings.NewReader(`{"folderId":"folder-1","title":"Docs","url":"https://example.com"}`)
	req := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/bookmarks", body)
	req.Header.Set(HeaderEventID, "evt-123")
	req.Header.Set(HeaderBaseCursor, "43")
	res := httptest.NewRecorder()

	mux.ServeHTTP(res, req)

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}
	if got := res.Header().Get(HeaderDuplicate); got != "true" {
		t.Fatalf("%s = %q, want true", HeaderDuplicate, got)
	}
	if got := res.Header().Get(HeaderCursor); got != "44" {
		t.Fatalf("%s = %q, want 44", HeaderCursor, got)
	}
	if store.createWorkspaceID != "workspace-1" || store.createUserID != "user-1" {
		t.Fatalf("unexpected call context: workspace=%s user=%s", store.createWorkspaceID, store.createUserID)
	}
	if store.createBookmarkMeta.EventID != "evt-123" {
		t.Fatalf("event id = %q, want evt-123", store.createBookmarkMeta.EventID)
	}
	if store.createBookmarkMeta.BaseCursor == nil || *store.createBookmarkMeta.BaseCursor != 43 {
		t.Fatalf("base cursor = %#v, want 43", store.createBookmarkMeta.BaseCursor)
	}

	var response bookmarks.Bookmark
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ID != "bookmark-1" {
		t.Fatalf("bookmark id = %q, want bookmark-1", response.ID)
	}
}

func TestRegisterBookmarkRoutesReusesStoredMutationForDuplicateEventID(t *testing.T) {
	t.Parallel()

	store := &fakeStore{duplicateByEventID: make(map[string]MutationResult[bookmarks.Bookmark])}
	service := NewService(store)
	mux := http.NewServeMux()
	authMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal := auth.Principal{UserID: "user-1", ClientID: "client-1"}
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal)))
		})
	}
	RegisterBookmarkRoutes(mux, authMiddleware, service, nil)

	makeRequest := func() *httptest.ResponseRecorder {
		body := strings.NewReader(`{"folderId":"folder-1","title":"Docs","url":"https://example.com"}`)
		req := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/bookmarks", body)
		req.Header.Set(HeaderEventID, "evt-duplicate")
		req.Header.Set(HeaderBaseCursor, "40")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}

	first := makeRequest()
	second := makeRequest()

	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("statuses = [%d %d], want [%d %d]", first.Code, second.Code, http.StatusCreated, http.StatusCreated)
	}
	if got := first.Header().Get(HeaderDuplicate); got != "false" {
		t.Fatalf("first %s = %q, want false", HeaderDuplicate, got)
	}
	if got := second.Header().Get(HeaderDuplicate); got != "true" {
		t.Fatalf("second %s = %q, want true", HeaderDuplicate, got)
	}
	if got, want := first.Header().Get(HeaderCursor), second.Header().Get(HeaderCursor); got != want {
		t.Fatalf("cursor mismatch: first=%q second=%q", got, want)
	}
	if store.mutationCount != 1 {
		t.Fatalf("mutationCount = %d, want 1", store.mutationCount)
	}

	var firstBody, secondBody bookmarks.Bookmark
	if err := json.NewDecoder(first.Body).Decode(&firstBody); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	if err := json.NewDecoder(second.Body).Decode(&secondBody); err != nil {
		t.Fatalf("decode second response: %v", err)
	}
	if firstBody != secondBody {
		t.Fatalf("duplicate response body mismatch: first=%#v second=%#v", firstBody, secondBody)
	}
}
