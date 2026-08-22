package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Phase 5 (Slice 5) — RED: writeAuthError must map the two new lifecycle
// sentinels explicitly. writeAuthError's default case is 400, so
// ErrAccountDisabled and ErrSoleOwner MUST be added as their own cases or
// this test fails. Pure logic, no database — a real executable RED->GREEN
// proof for this slice (mirrors organizations.TestWriteOrganizationErrorMapsInvitationSafetyErrors).
func TestWriteAuthErrorMapsLifecycleErrors(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "account disabled", err: ErrAccountDisabled, wantStatus: http.StatusForbidden},
		{name: "sole owner", err: ErrSoleOwner, wantStatus: http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeAuthError(recorder, tc.err)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
			if !strings.Contains(recorder.Body.String(), tc.err.Error()) {
				t.Fatalf("response body = %q, want stable error %q", recorder.Body.String(), tc.err)
			}
		})
	}
}
