package auth

import (
	"errors"
	"net/http"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, service *Service) {
	mux.HandleFunc("POST /auth/register", func(w http.ResponseWriter, r *http.Request) {
		var input RegisterInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		session, err := service.Register(r.Context(), input, clientIDFromRequest(r, service.ClientIDHeader()))
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

		session, err := service.Login(r.Context(), input, clientIDFromRequest(r, service.ClientIDHeader()))
		if err != nil {
			writeAuthError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, session)
	})

	mux.Handle("GET /me", service.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, principal)
	})))
}

func clientIDFromRequest(r *http.Request, headerName string) string {
	return strings.TrimSpace(r.Header.Get(headerName))
}

func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrUnauthorized):
		httpapi.WriteError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, ErrClientBinding):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}
