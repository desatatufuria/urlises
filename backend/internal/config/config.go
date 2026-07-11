package config

import (
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Server   ServerConfig
	Auth     AuthConfig
	Database DatabaseConfig
	Mail     MailConfig
}

type ServerConfig struct {
	Addr string
}

type AuthConfig struct {
	JWTSecret      []byte
	TokenTTL       time.Duration
	ClientIDHeader string
}

type DatabaseConfig struct {
	URL           string
	MaxConns      int32
	MinConns      int32
	MigrationsDir string
	AutoMigrate   bool
}

type TLSMode string

const (
	TLSModeNone     TLSMode = "none"
	TLSModeStartTLS TLSMode = "starttls"
	TLSModeTLS      TLSMode = "tls"
)

type AuthMode string

const (
	AuthModeNone  AuthMode = "none"
	AuthModePlain AuthMode = "plain"
)

type MailConfig struct {
	Enabled         bool
	Host            string
	Port            int
	Timeout         time.Duration
	TLSMode         TLSMode
	AuthMode        AuthMode
	Username        string
	Password        string
	FromAddress     string
	FromDisplayName string
	ReplyTo         string
}

func (c MailConfig) Validate() error {
	if !c.Enabled {
		return nil
	}

	if c.Host == "" {
		return fmt.Errorf("MAIL_SMTP_HOST is required when mail is enabled")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("MAIL_SMTP_PORT must be between 1 and 65535")
	}
	if c.Timeout <= 0 {
		return fmt.Errorf("MAIL_TIMEOUT must be positive")
	}
	if c.TLSMode != TLSModeNone && c.TLSMode != TLSModeStartTLS && c.TLSMode != TLSModeTLS {
		return fmt.Errorf("MAIL_TLS_MODE must be none, starttls, or tls")
	}
	if c.AuthMode != AuthModeNone && c.AuthMode != AuthModePlain {
		return fmt.Errorf("MAIL_AUTH_MODE must be none or plain")
	}
	if !validMailbox(c.FromAddress) || !safeHeader(c.FromDisplayName) {
		return fmt.Errorf("MAIL_FROM_ADDRESS and MAIL_FROM_DISPLAY_NAME must be valid when mail is enabled")
	}
	if !validMailbox(c.ReplyTo) {
		return fmt.Errorf("MAIL_REPLY_TO must be a valid mailbox when mail is enabled")
	}
	if c.AuthMode == AuthModePlain {
		if c.TLSMode == TLSModeNone {
			return fmt.Errorf("MAIL_AUTH_MODE plain requires TLS")
		}
		if c.Username == "" || c.Password == "" {
			return fmt.Errorf("MAIL_AUTH_MODE plain requires username and password")
		}
	}

	return nil
}

func Load() (Config, error) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required and must point to PostgreSQL")
	}

	jwtSecret := strings.TrimSpace(os.Getenv("AUTH_JWT_SECRET"))
	if jwtSecret == "" {
		return Config{}, fmt.Errorf("AUTH_JWT_SECRET is required")
	}

	rootDir := strings.TrimSpace(os.Getenv("APP_ROOT"))
	if rootDir == "" {
		rootDir = "."
	}

	maxConns, err := envInt32("DATABASE_MAX_CONNS", 10)
	if err != nil {
		return Config{}, err
	}

	minConns, err := envInt32("DATABASE_MIN_CONNS", 1)
	if err != nil {
		return Config{}, err
	}

	autoMigrate, err := envBool("DATABASE_AUTO_MIGRATE", true)
	if err != nil {
		return Config{}, err
	}

	tokenTTL, err := envDuration("AUTH_TOKEN_TTL", 24*time.Hour)
	if err != nil {
		return Config{}, err
	}

	mailEnabled, err := envBool("MAIL_ENABLED", false)
	if err != nil {
		return Config{}, err
	}
	mailPort, err := envInt("MAIL_SMTP_PORT", 587)
	if err != nil {
		return Config{}, err
	}
	mailTimeout, err := envDuration("MAIL_TIMEOUT", 10*time.Second)
	if err != nil {
		return Config{}, err
	}
	mailConfig := MailConfig{
		Enabled:         mailEnabled,
		Host:            strings.TrimSpace(os.Getenv("MAIL_SMTP_HOST")),
		Port:            mailPort,
		Timeout:         mailTimeout,
		TLSMode:         TLSMode(envString("MAIL_TLS_MODE", string(TLSModeStartTLS))),
		AuthMode:        AuthMode(envString("MAIL_AUTH_MODE", string(AuthModeNone))),
		Username:        strings.TrimSpace(os.Getenv("MAIL_USERNAME")),
		Password:        strings.TrimSpace(os.Getenv("MAIL_PASSWORD")),
		FromAddress:     strings.TrimSpace(os.Getenv("MAIL_FROM_ADDRESS")),
		FromDisplayName: strings.TrimSpace(os.Getenv("MAIL_FROM_DISPLAY_NAME")),
		ReplyTo:         strings.TrimSpace(os.Getenv("MAIL_REPLY_TO")),
	}
	if mailConfig.AuthMode == AuthModeNone {
		mailConfig.Username = ""
		mailConfig.Password = ""
	}
	if err := mailConfig.Validate(); err != nil {
		return Config{}, err
	}

	return Config{
		Server: ServerConfig{
			Addr: envString("SERVER_ADDR", ":8080"),
		},
		Auth: AuthConfig{
			JWTSecret:      []byte(jwtSecret),
			TokenTTL:       tokenTTL,
			ClientIDHeader: envString("AUTH_CLIENT_ID_HEADER", "X-Client-Id"),
		},
		Database: DatabaseConfig{
			URL:           databaseURL,
			MaxConns:      maxConns,
			MinConns:      minConns,
			MigrationsDir: filepath.Clean(filepath.Join(rootDir, envString("DATABASE_MIGRATIONS_DIR", "migrations"))),
			AutoMigrate:   autoMigrate,
		},
		Mail: mailConfig,
	}, nil
}

func validMailbox(value string) bool {
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value
}

func safeHeader(value string) bool {
	return strings.TrimSpace(value) != "" && !strings.ContainsAny(value, "\r\n")
}

func envString(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	return value
}

func envInt32(key string, fallback int32) (int32, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", key, err)
	}

	return int32(parsed), nil
}

func envInt(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", key, err)
	}
	return parsed, nil
}

func envBool(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("parse %s: %w", key, err)
	}

	return parsed, nil
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}

	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", key, err)
	}

	return parsed, nil
}
