package bookmarks

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"

	"github.com/jackc/pgx/v5"
)

type siblingScopeKey struct {
	kind        string
	workspaceID string
	parentID    string
}

type prepareScopeDriftError struct{}

func (e *prepareScopeDriftError) Error() string { return "prepare scope drift" }

func isRetryablePrepareError(err error) bool {
	var drift *prepareScopeDriftError
	return errors.As(err, &drift)
}

// prepareScopesTx locks every discovered scope before the caller may lock a
// target or sibling row, then refuses the transaction if locked rederivation
// observes different scopes.
func prepareScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey, lockRows func() error, rederive func() ([]siblingScopeKey, error)) error {
	initial := sortedScopeKeys(scopes)
	if err := lockScopesTx(ctx, tx, initial); err != nil {
		return err
	}
	if err := lockRows(); err != nil {
		return err
	}
	current, err := rederive()
	if err != nil {
		return err
	}
	if !equalScopeKeys(initial, sortedScopeKeys(current)) {
		return &prepareScopeDriftError{}
	}
	return nil
}

func lockScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey) error {
	for _, scope := range sortedScopeKeys(scopes) {
		hash := fnv.New64a()
		_, _ = fmt.Fprintf(hash, "%s:%s:%s", scope.kind, scope.workspaceID, scope.parentID)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(hash.Sum64())); err != nil {
			return fmt.Errorf("lock prepare scope: %w", err)
		}
	}
	return nil
}

func sortedScopeKeys(scopes []siblingScopeKey) []siblingScopeKey {
	keys := append([]siblingScopeKey(nil), scopes...)
	sort.Slice(keys, func(i, j int) bool {
		return keys[i].kind+"\x00"+keys[i].workspaceID+"\x00"+keys[i].parentID < keys[j].kind+"\x00"+keys[j].workspaceID+"\x00"+keys[j].parentID
	})
	result := keys[:0]
	for _, key := range keys {
		if len(result) == 0 || result[len(result)-1] != key {
			result = append(result, key)
		}
	}
	return result
}

func equalScopeKeys(left, right []siblingScopeKey) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
