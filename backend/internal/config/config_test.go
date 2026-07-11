package config

import (
	"os"
	"testing"
)

func TestLoadMailConfig(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"disabled defaults", nil, true},
		{"enabled valid plain TLS", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_SMTP_PORT": "465", "MAIL_TLS_MODE": "tls", "MAIL_AUTH_MODE": "plain", "MAIL_USERNAME": "user", "MAIL_PASSWORD": "secret", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test"}, true},
		{"plain without TLS", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_TLS_MODE": "none", "MAIL_AUTH_MODE": "plain", "MAIL_USERNAME": "user", "MAIL_PASSWORD": "secret", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test"}, false},
		{"invalid enabled port", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_SMTP_PORT": "0", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test"}, false},
		{"none clears credentials", map[string]string{"MAIL_ENABLED": "true", "MAIL_SMTP_HOST": "smtp.example.test", "MAIL_TLS_MODE": "none", "MAIL_AUTH_MODE": "none", "MAIL_USERNAME": "ignored", "MAIL_PASSWORD": "ignored", "MAIL_FROM_ADDRESS": "mail@example.test", "MAIL_FROM_DISPLAY_NAME": "Platform", "MAIL_REPLY_TO": "support@example.test"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://example")
			t.Setenv("AUTH_JWT_SECRET", "test-secret")
			for _, key := range []string{"MAIL_ENABLED", "MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_TIMEOUT", "MAIL_TLS_MODE", "MAIL_AUTH_MODE", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_FROM_ADDRESS", "MAIL_FROM_DISPLAY_NAME", "MAIL_REPLY_TO"} {
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

func TestLoadMailConfigDoesNotDial(t *testing.T) {
	os.Unsetenv("MAIL_ENABLED")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("AUTH_JWT_SECRET", "test-secret")
	if _, err := Load(); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}
