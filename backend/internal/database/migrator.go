package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Migrate(ctx context.Context, pool *pgxpool.Pool, migrationsDir string) error {
	if err := ensureMigrationTable(ctx, pool); err != nil {
		return err
	}

	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir %q: %w", migrationsDir, err)
	}

	filenames := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}

		filenames = append(filenames, entry.Name())
	}

	sort.Strings(filenames)

	for _, filename := range filenames {
		applied, err := migrationApplied(ctx, pool, filename)
		if err != nil {
			return err
		}
		if applied {
			continue
		}

		contents, err := os.ReadFile(filepath.Join(migrationsDir, filename))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", filename, err)
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", filename, err)
		}

		if _, err := tx.Exec(ctx, string(contents)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", filename, err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO schema_migrations (filename)
			VALUES ($1)
		`, filename); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", filename, err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", filename, err)
		}
	}

	return nil
}

func ensureMigrationTable(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	if err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}

	return nil
}

func migrationApplied(ctx context.Context, pool *pgxpool.Pool, filename string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM schema_migrations
			WHERE filename = $1
		)
	`, filename).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check migration %s: %w", filename, err)
	}

	return exists, nil
}
