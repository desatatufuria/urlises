// Package purge holds the shared retention window for soft-deleted
// organizations and workspaces (design.md "Home of the window constant").
// Window is the single source of truth for two independent consumers:
//
//   - The Trash "days remaining" countdown: purgeAt is computed
//     server-side as deleted_at + Window by the Trash list queries
//     (organizations.ListDeletedOrganizations, workspaces.ListDeleted).
//   - The eventual scheduled purge sweep, which hard-deletes rows once
//     they age past Window. The sweep itself (Sweeper, Sweep, Run) is
//     added by a later unit; this file intentionally holds only the
//     constant, so the countdown and the sweep can never drift apart on
//     the interval they share, and slice 3 stays independently shippable
//     without slice 4.
package purge

import (
	"context"
	"fmt"
	"io"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Window is the recovery period a soft-deleted organization or workspace
// stays restorable before it becomes eligible for the purge sweep.
const Window = 30 * 24 * time.Hour

// Result is the count of rows a single Sweep call hard-deleted, split by
// entity type. Exec + RowsAffected() populates it (design.md "Purge result
// capture") -- observability needs counts, not identifiers, so the sweep
// never uses DELETE ... RETURNING id.
type Result struct {
	Organizations int64
	Workspaces    int64
}

// Sweeper hard-deletes organizations and workspaces once their deleted_at
// ages past Window. A single production instance is assumed (design.md
// "Sweep transaction and locking"): the sweep runs inside one transaction,
// with no advisory lock. If a second instance is ever introduced, a
// concurrent sweep blocks on row locks, then finds 0 rows and logs a
// 0-count line -- it fails safe, not silently double-purges. An advisory
// lock becomes mandatory only once more than one process runs this sweep.
type Sweeper struct {
	pool   *pgxpool.Pool
	output io.Writer
}

// NewSweeper builds a Sweeper. output receives one structured log line per
// Sweep call (see logSweepCompleted / logSweepFailed).
func NewSweeper(pool *pgxpool.Pool, output io.Writer) *Sweeper {
	return &Sweeper{pool: pool, output: output}
}

// Sweep hard-deletes organizations first, then workspaces, inside a single
// transaction (design.md Data Flow, slice 4): purging organizations first
// lets their workspaces cascade away via FK before the workspace-only pass
// runs, so that second DELETE only catches workspaces that were
// individually soft-deleted -- RowsAffected()==0 on already-cascaded rows
// is expected, not an error. A cancelled ctx aborts the transaction with no
// partial commit. Every call logs exactly one structured line, success or
// failure -- the zero-count line is the ticker's heartbeat.
func (s *Sweeper) Sweep(ctx context.Context) (Result, error) {
	started := time.Now()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		logSweepFailed(s.output)
		return Result{}, fmt.Errorf("begin purge sweep tx: %w", err)
	}
	defer tx.Rollback(ctx)

	windowInterval := windowIntervalLiteral()

	orgTag, err := tx.Exec(ctx, `
		DELETE FROM organizations WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - $1::interval
	`, windowInterval)
	if err != nil {
		logSweepFailed(s.output)
		return Result{}, fmt.Errorf("purge organizations: %w", err)
	}

	workspaceTag, err := tx.Exec(ctx, `
		DELETE FROM workspaces WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - $1::interval
	`, windowInterval)
	if err != nil {
		logSweepFailed(s.output)
		return Result{}, fmt.Errorf("purge workspaces: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		logSweepFailed(s.output)
		return Result{}, fmt.Errorf("commit purge sweep tx: %w", err)
	}

	result := Result{
		Organizations: orgTag.RowsAffected(),
		Workspaces:    workspaceTag.RowsAffected(),
	}
	logSweepCompleted(s.output, result, time.Since(started))
	return result, nil
}

// Run fires Sweep on every tick until ctx is cancelled. It mirrors the
// existing idempotencyExecutor.Cleanup ticker in cmd/api/main.go -- same
// shape, same 1-hour cadence -- so the process has one background
// scheduling idiom (design.md "Sweep interval"). Sweep errors are already
// logged inside Sweep itself; Run does not log again.
func (s *Sweeper) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = s.Sweep(ctx)
		}
	}
}

// windowIntervalLiteral formats Window as a Postgres interval literal.
// This is the identical one-line format organizations.purgeWindowIntervalLiteral
// already uses; it is duplicated here (not imported, to avoid a purge -> organizations
// dependency cycle) as design.md instructs -- keep the formatting logic consistent,
// not shared, since purge is the single source of truth for Window itself.
func windowIntervalLiteral() string {
	return fmt.Sprintf("%d seconds", int64(Window/time.Second))
}

// logSweepCompleted emits one structured line per Sweep call, always --
// including zero-count sweeps, which serve as the ticker's heartbeat
// (design.md "Purge observability"). Follows this repo's existing
// event=key value idiom (httpapi/errors.go).
func logSweepCompleted(output io.Writer, result Result, duration time.Duration) {
	log.New(output, "", 0).Printf(
		"event=purge_sweep_completed organizations=%d workspaces=%d duration_ms=%d",
		result.Organizations, result.Workspaces, duration.Milliseconds(),
	)
}

// logSweepFailed logs a sweep failure with deliberately no error detail,
// following LogIdempotencyCleanupFailure's no-detail-on-failure policy
// (httpapi/errors.go) so pgx credentials or query text never reach logs.
func logSweepFailed(output io.Writer) {
	log.New(output, "", 0).Print("event=purge_sweep_failed")
}
