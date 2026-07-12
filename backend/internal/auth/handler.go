package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

const renewableCapabilityHeader = "X-Session-Capability"
const renewableCapability = "renewable-v1"

type invitationAccepter interface {
	AcceptInvitation(ctx context.Context, userID, token string) (any, error)
}

func RegisterRoutes(mux *http.ServeMux, service *Service, invitations invitationAccepter) {
	mux.HandleFunc("POST /auth/register", func(w http.ResponseWriter, r *http.Request) {
		var input RegisterInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		clientID := clientIDFromRequest(r, service.ClientIDHeader())
		if renewableRequested(r) {
			session, err := service.RegisterRenewable(r.Context(), input, clientID)
			if err != nil {
				writeAuthError(w, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusCreated, session)
			return
		}
		session, err := service.Register(r.Context(), input, clientID)
		if err != nil {
			writeAuthError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, session)
	})

	mux.HandleFunc("POST /auth/login", func(w http.ResponseWriter, r *http.Request) {
		var input LoginInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		clientID := clientIDFromRequest(r, service.ClientIDHeader())
		if renewableRequested(r) {
			session, err := service.LoginRenewable(r.Context(), input, clientID)
			if err != nil {
				writeAuthError(w, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, session)
			return
		}
		session, err := service.Login(r.Context(), input, clientID)
		if err != nil {
			writeAuthError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, session)
	})

	mux.HandleFunc("POST /auth/refresh", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RefreshToken string `json:"refreshToken"`
			AttemptID    string `json:"attemptId"`
		}
		if err := httpapi.DecodeJSON(r, &input); err != nil || strings.TrimSpace(input.RefreshToken) == "" || strings.TrimSpace(input.AttemptID) == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "refreshToken and attemptId are required")
			return
		}
		session, err := service.Refresh(r.Context(), input.RefreshToken, input.AttemptID, clientIDFromRequest(r, service.ClientIDHeader()))
		if err != nil {
			writeAuthError(w, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, session)
	})

	mux.HandleFunc("POST /auth/logout", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RefreshToken string `json:"refreshToken"`
		}
		if err := httpapi.DecodeJSON(r, &input); err != nil || strings.TrimSpace(input.RefreshToken) == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "refreshToken is required")
			return
		}
		if err := service.Logout(r.Context(), input.RefreshToken, clientIDFromRequest(r, service.ClientIDHeader())); err != nil {
			writeAuthError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	mux.Handle("GET /me", service.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, principal)
	})))

	mux.Handle("POST /auth/ws-ticket", service.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		ticket, err := service.CreateWSTicket(r.Context(), principal)
		if err != nil {
			writeAuthError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store, no-cache")
		w.Header().Set("Pragma", "no-cache")
		httpapi.WriteJSON(w, http.StatusOK, ticket)
	})))

	if invitations != nil {
		mux.Handle("POST /invitations/{token}/accept", service.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal, ok := PrincipalFromContext(r.Context())
			if !ok {
				httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
				return
			}

			accepted, err := invitations.AcceptInvitation(r.Context(), principal.UserID, r.PathValue("token"))
			if err != nil {
				writeInvitationError(w, err)
				return
			}

			httpapi.WriteJSON(w, http.StatusOK, accepted)
		})))
	}
}

func clientIDFromRequest(r *http.Request, headerName string) string {
	return strings.TrimSpace(r.Header.Get(headerName))
}

func renewableRequested(r *http.Request) bool {
	return r.Header.Get(renewableCapabilityHeader) == renewableCapability
}

func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrUnauthorized):
		httpapi.WriteError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, ErrClientBinding):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrRefreshUnavailable):
		httpapi.WriteError(w, http.StatusServiceUnavailable, "unavailable")
	case errors.Is(err, ErrTicketUnavailable):
		httpapi.WriteError(w, http.StatusServiceUnavailable, "unavailable")
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

func writeInvitationError(w http.ResponseWriter, err error) {
	switch {
	case err.Error() == "forbidden":
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case err.Error() == "not found":
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	case err.Error() == "invitation is not pending", err.Error() == "invitation email does not match authenticated user":
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}
