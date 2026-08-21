package auth

import (
	"context"
	"errors"
	"fmt"
)

// UITheme identifies one of the extension's supported color themes for a
// user's own UI (popup/options page). It lives in the auth package rather
// than internal/config because it is a per-user account attribute, not
// server/mail configuration, following the same const-enum + explicit
// allowed-set validation pattern as config.TLSMode/config.AuthMode.
type UITheme string

const (
	UIThemeSlate  UITheme = "slate"
	UIThemeIndigo UITheme = "indigo"
	UIThemeTeal   UITheme = "teal"
)

// ErrInvalidUITheme is returned when a caller attempts to set an unknown
// theme value. Only UIThemeSlate, UIThemeIndigo, and UIThemeTeal are valid.
var ErrInvalidUITheme = errors.New("invalid ui theme")

// validUITheme reports whether theme is one of the three supported values.
func validUITheme(theme UITheme) bool {
	switch theme {
	case UIThemeSlate, UIThemeIndigo, UIThemeTeal:
		return true
	default:
		return false
	}
}

// Preferences holds a user's own account-level UI preferences. It is
// intentionally separate from Principal/JWT claims: preferences change
// rarely and don't need to be baked into every authenticated request.
type Preferences struct {
	UITheme string `json:"uiTheme"`
}

// GetPreferences returns the caller's persisted UI preferences.
func (s *Service) GetPreferences(ctx context.Context, userID string) (Preferences, error) {
	var theme string
	if err := s.pool.QueryRow(ctx, `SELECT ui_theme FROM users WHERE id = $1`, userID).Scan(&theme); err != nil {
		return Preferences{}, fmt.Errorf("load preferences: %w", err)
	}
	return Preferences{UITheme: theme}, nil
}

// UpdatePreferences validates uiTheme against the fixed allowed set and
// persists it for the caller, returning the updated preferences on success.
func (s *Service) UpdatePreferences(ctx context.Context, userID, uiTheme string) (Preferences, error) {
	theme := UITheme(uiTheme)
	if !validUITheme(theme) {
		return Preferences{}, ErrInvalidUITheme
	}

	if _, err := s.pool.Exec(ctx, `UPDATE users SET ui_theme = $1, updated_at = NOW() WHERE id = $2`, string(theme), userID); err != nil {
		return Preferences{}, fmt.Errorf("update preferences: %w", err)
	}

	return Preferences{UITheme: string(theme)}, nil
}
