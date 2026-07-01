package config

import (
	"fmt"
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
	}, nil
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
