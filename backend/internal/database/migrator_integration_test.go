package database

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateSortsAndRecordsFixtureMigrations(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL migration test in short mode")
	}
	ctx, pool := openMigratorTestPool(t)
	dir := t.TempDir()
	for filename, contents := range map[string]string{
		"000002_second.sql": "INSERT INTO migration_order (position) VALUES (2);",
		"000001_first.sql":  "CREATE TABLE migration_order (position INTEGER NOT NULL); INSERT INTO migration_order (position) VALUES (1);",
	} {
		if err := os.WriteFile(dir+"/"+filename, []byte(contents), 0o600); err != nil {
			t.Fatalf("write migration fixture %s: %v", filename, err)
		}
	}
	if err := Migrate(ctx, pool, dir); err != nil {
		t.Fatalf("migrate fixture: %v", err)
	}
	var positions []int
	rows, err := pool.Query(ctx, `SELECT position FROM migration_order ORDER BY position`)
	if err != nil {
		t.Fatalf("query migration order: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var position int
		if err := rows.Scan(&position); err != nil {
			t.Fatalf("scan position: %v", err)
		}
		positions = append(positions, position)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate positions: %v", err)
	}
	if fmt.Sprint(positions) != "[1 2]" {
		t.Fatalf("migration execution order = %v, want [1 2]", positions)
	}
	assertMigratorLedger(t, ctx, pool, []string{"000001_first.sql", "000002_second.sql"})
	if err := Migrate(ctx, pool, dir); err != nil {
		t.Fatalf("rerun fixture migrations: %v", err)
	}
	assertMigratorLedger(t, ctx, pool, []string{"000001_first.sql", "000002_second.sql"})
}

func openMigratorTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("ORGANIZATIONS_TEST_DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Fatal("set DATABASE_URL or ORGANIZATIONS_TEST_DATABASE_URL to run PostgreSQL migration tests")
	}
	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Fatalf("ping PostgreSQL: %v", err)
	}
	schemaName := fmt.Sprintf("migrator_integration_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schemaName)); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName)); err != nil {
			t.Errorf("drop schema: %v", err)
		}
		adminPool.Close()
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open schema pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func assertMigratorLedger(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want []string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT filename FROM schema_migrations ORDER BY filename`)
	if err != nil {
		t.Fatalf("query migration ledger: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var filename string
		if err := rows.Scan(&filename); err != nil {
			t.Fatalf("scan migration ledger: %v", err)
		}
		got = append(got, filename)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate migration ledger: %v", err)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("migration ledger = %v, want %v", got, want)
	}
}
