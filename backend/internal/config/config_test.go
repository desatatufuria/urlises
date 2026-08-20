package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadMailConfig(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"disabled defaults", nil, true},
		{"enabled valid plain TLS", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_SMTP_PORT": "465", "MAIL_TLS_MODE": "tls", "MAIL_AUTH_MODE": "plain", "MAIL_USERNAME": "user", "MAIL_PASSWORD": "secret", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test", "PUBLIC_BASE_URL": "https://admin.example.test"}, true},
		{"plain without TLS", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_TLS_MODE": "none", "MAIL_AUTH_MODE": "plain", "MAIL_USERNAME": "user", "MAIL_PASSWORD": "secret", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test", "PUBLIC_BASE_URL": "https://admin.example.test"}, false},
		{"invalid enabled port", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_SMTP_PORT": "0", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test", "PUBLIC_BASE_URL": "https://admin.example.test"}, false},
		{"none clears credentials", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_TLS_MODE": "none", "MAIL_AUTH_MODE": "none", "MAIL_USERNAME": "ignored", "MAIL_PASSWORD": "ignored", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test", "PUBLIC_BASE_URL": "https://admin.example.test"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://example")
			t.Setenv("AUTH_JWT_SECRET", "test-secret")
			for _, key := range []string{"MAIL_ENABLED", "MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_TIMEOUT", "MAIL_TLS_MODE", "MAIL_AUTH_MODE", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_FROM_ADDRESS", "MAIL_FROM_DISPLAY_NAME", "MAIL_REPLY_TO", "PUBLIC_BASE_URL"} {
				if value, ok := tt.env[key]; ok {
					t.Setenv(key, value)
				} else {
					t.Setenv(key, "")
				}
			}
			cfg, err := Load()
			if (err == nil) != tt.want {
				t.Fatalf("Load() error = %v, want success %v", err, tt.want)
			}
			if tt.name == "disabled defaults" && (cfg.Mail.Enabled || cfg.Mail.Port != 587 || cfg.Mail.TLSMode != TLSModeStartTLS) {
				t.Fatalf("unexpected disabled defaults: %#v", cfg.Mail)
			}
			if tt.name == "none clears credentials" && (cfg.Mail.Username != "" || cfg.Mail.Password != "") {
				t.Fatal("none auth retained credentials")
			}
		})
	}
}

func TestLoadAuthTokenTTL(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("AUTH_JWT_SECRET", "test-secret")
	t.Setenv("AUTH_TOKEN_TTL", "")
	cfg, err := Load()
	if err != nil || cfg.Auth.TokenTTL != 15*time.Minute {
		t.Fatalf("default TokenTTL = %v, %v; want 15m, nil", cfg.Auth.TokenTTL, err)
	}
	t.Setenv("AUTH_TOKEN_TTL", "2s")
	cfg, err = Load()
	if err != nil || cfg.Auth.TokenTTL != 2*time.Second {
		t.Fatalf("override TokenTTL = %v, %v; want 2s, nil", cfg.Auth.TokenTTL, err)
	}
}

func TestLoadMailConfigDoesNotDial(t *testing.T) {
	os.Unsetenv("MAIL_ENABLED")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("AUTH_JWT_SECRET", "test-secret")
	if _, err := Load(); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadPublicBaseURL(t *testing.T) {
	validMailEnv := map[string]string{
		"MAIL_ENABLED":           "true",
		"MAIL_SMTP_HOST":         "smtp.example.test",
		"MAIL_SMTP_PORT":         "465",
		"MAIL_TLS_MODE":          "tls",
		"MAIL_AUTH_MODE":         "plain",
		"MAIL_USERNAME":          "user",
		"MAIL_PASSWORD":          "secret",
		"MAIL_FROM_ADDRESS":      "mail@example.test",
		"MAIL_FROM_DISPLAY_NAME": "Platform",
		"MAIL_REPLY_TO":          "support@example.test",
	}
	tests := []struct {
		name          string
		mailEnabled   bool
		publicBaseURL string
		wantErr       bool
		wantValue     string
	}{
		{"missing when mail enabled", true, "", true, ""},
		{"malformed scheme", true, "ftp://admin.example.com", true, ""},
		{"missing host", true, "https:", true, ""},
		{"query rejected", true, "https://admin.example.com?x=1", true, ""},
		{"fragment rejected", true, "https://admin.example.com#frag", true, ""},
		{"trailing slash trimmed", true, "https://admin.example.com/", false, "https://admin.example.com"},
		{"valid https", true, "https://admin.example.com", false, "https://admin.example.com"},
		{"empty allowed when mail disabled", false, "", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://example")
			t.Setenv("AUTH_JWT_SECRET", "test-secret")
			for _, key := range []string{"MAIL_ENABLED", "MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_TIMEOUT", "MAIL_TLS_MODE", "MAIL_AUTH_MODE", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_FROM_ADDRESS", "MAIL_FROM_DISPLAY_NAME", "MAIL_REPLY_TO"} {
				if tt.mailEnabled {
					t.Setenv(key, validMailEnv[key])
				} else {
					t.Setenv(key, "")
				}
			}
			if !tt.mailEnabled {
				t.Setenv("MAIL_ENABLED", "false")
			}
			t.Setenv("PUBLIC_BASE_URL", tt.publicBaseURL)

			cfg, err := Load()
			if (err != nil) != tt.wantErr {
				t.Fatalf("Load() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && cfg.App.PublicBaseURL != tt.wantValue {
				t.Fatalf("PublicBaseURL = %q, want %q", cfg.App.PublicBaseURL, tt.wantValue)
			}
		})
	}
}
