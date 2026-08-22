package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	migrationsDir := strings.TrimSpace(os.Getenv("DATABASE_MIGRATIONS_DIR"))
	if migrationsDir == "" {
		migrationsDir = "migrations"
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("create postgres pool: %w", err)
	}
	defer pool.Close()

	if err := database.Migrate(ctx, pool, migrationsDir); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	return nil
}
