package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrTicketUnavailable = errors.New("ticket operation unavailable")

type WSTicket struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ticketRepository struct{ pool *pgxpool.Pool }

func (r *ticketRepository) create(ctx context.Context, p Principal) (WSTicket, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return WSTicket{}, ErrTicketUnavailable
	}
	t := base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(t))
	var out WSTicket
	err := r.pool.QueryRow(ctx, `INSERT INTO ws_tickets(ticket_hash,user_id,device_id,client_id)
SELECT $1,d.user_id,d.id,d.client_id FROM devices d WHERE d.user_id=$2 AND d.client_id=$3 RETURNING expires_at`, h[:], p.UserID, p.ClientID).Scan(&out.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WSTicket{}, ErrUnauthorized
		}
		return WSTicket{}, ErrTicketUnavailable
	}
	out.Ticket = t
	return out, nil
}

func (r *ticketRepository) consume(ctx context.Context, ticket string) (Principal, error) {
	if ticket == "" {
		return Principal{}, ErrUnauthorized
	}
	h := sha256.Sum256([]byte(ticket))
	var p Principal
	err := r.pool.QueryRow(ctx, `UPDATE ws_tickets t SET consumed_at=NOW() FROM users u WHERE t.ticket_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>NOW() AND u.id=t.user_id RETURNING u.id,u.email,COALESCE(u.name,''),t.client_id`, h[:]).Scan(&p.UserID, &p.Email, &p.Name, &p.ClientID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrUnauthorized
	}
	if err != nil {
		return Principal{}, ErrTicketUnavailable
	}
	return p, nil
}
