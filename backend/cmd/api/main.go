package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/groups"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
	"github.com/furia/shared-bookmark-sync/backend/internal/organizations"
	syncapi "github.com/furia/shared-bookmark-sync/backend/internal/sync"
	wsapi "github.com/furia/shared-bookmark-sync/backend/internal/websocket"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
)

type invitationAccepterAdapter struct {
	service *organizations.Service
}

func (a invitationAccepterAdapter) AcceptInvitation(ctx context.Context, userID, token string) (any, error) {
	return a.service.AcceptInvitation(ctx, userID, token)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	pool, err := database.Open(ctx, cfg.Database)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer pool.Close()

	if cfg.Database.AutoMigrate {
		if err := database.Migrate(ctx, pool, cfg.Database.MigrationsDir); err != nil {
			log.Fatalf("run migrations: %v", err)
		}
	}

	mux := http.NewServeMux()
	authService := auth.NewService(pool, cfg.Auth)
	accessService := access.NewService(pool)
	organizationsService := organizations.NewService(pool)
	invitationMailer := mailer.NewSMTP(cfg.Mail)
	invitationNotifier := organizations.NewMailInvitationNotifier(invitationMailer, cfg.App.PublicBaseURL, os.Stdout)
	groupsService := groups.NewService(pool)
	workspacesService := workspaces.NewService(pool, accessService)
	idempotencyExecutor := httpapi.NewIdempotencyExecutor(pool)
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := idempotencyExecutor.Cleanup(ctx, 100); err != nil {
					httpapi.LogIdempotencyCleanupFailure(os.Stderr)
				}
			}
		}
	}()
	bookmarksService := bookmarks.NewService(pool, accessService)
	websocketHub := wsapi.NewHub()
	syncService := syncapi.NewService(syncapi.NewPostgresStore(pool, bookmarksService, workspacesService, websocketHub))

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpapi.WriteJSON(w, http.StatusOK, map[string]string{
			"status":  "ok",
			"service": "shared-bookmark-sync-api",
		})
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		pingCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		if err := pool.Ping(pingCtx); err != nil {
			httpapi.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
				"status": "error",
				"error":  err.Error(),
			})
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]string{
			"status":   "ready",
			"database": "reachable",
		})
	})

	auth.RegisterRoutes(mux, authService, invitationAccepterAdapter{service: organizationsService})
	organizations.RegisterRoutes(mux, authService.Middleware, organizationsService, invitationNotifier, idempotencyExecutor)
	groups.RegisterRoutes(mux, authService.Middleware, groupsService, idempotencyExecutor)
	workspaces.RegisterRoutes(mux, authService.Middleware, workspacesService, idempotencyExecutor)
	syncapi.RegisterBookmarkRoutes(mux, authService.Middleware, syncService, idempotencyExecutor)
	syncapi.RegisterRoutes(mux, authService.Middleware, syncService)
	wsapi.RegisterRoutes(mux, authService, workspacesService, syncService, websocketHub)

	server := &http.Server{
		Addr:              cfg.Server.Addr,
		Handler:           httpapi.NewCORS(httpapi.NewErrorMiddleware(mux, os.Stderr), cfg.CORS.AllowedOrigins),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("api listening on %s", cfg.Server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		log.Fatalf("serve api: %v", err)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
		if closeErr := server.Close(); closeErr != nil {
			log.Printf("force close failed: %v", closeErr)
		}
	}
}
