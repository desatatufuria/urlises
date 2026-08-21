package auth

import (
	"errors"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

// RED: a freshly registered user has no explicit preference yet, so
// GetPreferences must default to the "slate" theme (matches the migration's
// column default).
func TestGetPreferencesDefaultsToSlate(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	session, err := service.Register(ctx, RegisterInput{Email: "prefs-default@example.test", Password: "password"}, "prefs-default-client")
	if err != nil {
		t.Fatal(err)
	}

	prefs, err := service.GetPreferences(ctx, session.User.ID)
	if err != nil {
		t.Fatalf("GetPreferences() err = %v, want nil", err)
	}
	if prefs.UITheme != "slate" {
		t.Fatalf("UITheme = %q, want slate", prefs.UITheme)
	}
}

// RED: updating preferences to each of the three valid themes must persist
// and be readable back via GetPreferences.
func TestUpdatePreferencesPersistsEachValidTheme(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	session, err := service.Register(ctx, RegisterInput{Email: "prefs-update@example.test", Password: "password"}, "prefs-update-client")
	if err != nil {
		t.Fatal(err)
	}

	for _, theme := range []string{"indigo", "teal", "slate"} {
		updated, err := service.UpdatePreferences(ctx, session.User.ID, theme)
		if err != nil {
			t.Fatalf("UpdatePreferences(%q) err = %v, want nil", theme, err)
		}
		if updated.UITheme != theme {
			t.Fatalf("UpdatePreferences(%q) returned %q", theme, updated.UITheme)
		}

		loaded, err := service.GetPreferences(ctx, session.User.ID)
		if err != nil {
			t.Fatalf("GetPreferences() err = %v, want nil", err)
		}
		if loaded.UITheme != theme {
			t.Fatalf("persisted UITheme = %q, want %q", loaded.UITheme, theme)
		}
	}
}

// RED: an unknown theme value must be rejected with ErrInvalidUITheme and
// must not mutate the stored preference.
func TestUpdatePreferencesRejectsInvalidTheme(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	session, err := service.Register(ctx, RegisterInput{Email: "prefs-invalid@example.test", Password: "password"}, "prefs-invalid-client")
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.UpdatePreferences(ctx, session.User.ID, "cyberpunk-neon")
	if !errors.Is(err, ErrInvalidUITheme) {
		t.Fatalf("err = %v, want %v", err, ErrInvalidUITheme)
	}

	prefs, err := service.GetPreferences(ctx, session.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if prefs.UITheme != "slate" {
		t.Fatalf("UITheme after rejected update = %q, want unchanged slate", prefs.UITheme)
	}
}
