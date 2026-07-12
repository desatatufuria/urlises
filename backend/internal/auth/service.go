package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrUnauthorized       = errors.New("unauthorized")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrClientBinding      = errors.New("client ID is already bound to another user")
	ErrRefreshUnavailable = errors.New("refresh operation unavailable")
)

type Service struct {
	pool           *pgxpool.Pool
	refresh        *refreshRepository
	jwtSecret      []byte
	tokenTTL       time.Duration
	clientIDHeader string
}

type Principal struct {
	UserID   string `json:"userId"`
	Email    string `json:"email"`
	Name     string `json:"name,omitempty"`
	ClientID string `json:"clientId"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type Session struct {
	AccessToken string    `json:"accessToken"`
	ExpiresAt   time.Time `json:"expiresAt"`
	ClientID    string    `json:"clientId"`
	User        User      `json:"user"`
}

type RegisterInput struct {
	Email      string `json:"email"`
	Name       string `json:"name"`
	Password   string `json:"password"`
	DeviceName string `json:"deviceName"`
}

type LoginInput struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	DeviceName string `json:"deviceName"`
}

type tokenClaims struct {
	ClientID string `json:"clientId"`
	jwt.RegisteredClaims
}

func NewService(pool *pgxpool.Pool, cfg config.AuthConfig) *Service {
	return &Service{
		pool:           pool,
		refresh:        newRefreshRepository(pool, cfg.JWTSecret),
		jwtSecret:      cfg.JWTSecret,
		tokenTTL:       cfg.TokenTTL,
		clientIDHeader: cfg.ClientIDHeader,
	}
}

// RevokeAllRefreshFamilies is called by password-change and recovery transactions.
func (s *Service) RevokeAllRefreshFamilies(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.RevokeAllRefreshFamiliesTx(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) RevokeAllRefreshFamiliesTx(ctx context.Context, tx pgx.Tx, userID string) error {
	return s.refresh.revokeAllTx(ctx, tx, userID)
}

func (s *Service) ClientIDHeader() string {
	return s.clientIDHeader
}

func (s *Service) Register(ctx context.Context, input RegisterInput, clientID string) (Session, error) {
	input.Email = strings.TrimSpace(strings.ToLower(input.Email))
	input.Name = strings.TrimSpace(input.Name)
	input.Password = strings.TrimSpace(input.Password)

	if input.Email == "" || input.Password == "" {
		return Session{}, fmt.Errorf("email and password are required")
	}
	if clientID == "" {
		return Session{}, fmt.Errorf("client ID is required")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return Session{}, fmt.Errorf("hash password: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("begin register tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var user User
	err = tx.QueryRow(ctx, `
		INSERT INTO users (email, name, password_hash)
		VALUES ($1, $2, $3)
		RETURNING id, email, COALESCE(name, '')
	`, input.Email, nullableString(input.Name), string(hash)).Scan(&user.ID, &user.Email, &user.Name)
	if err != nil {
		return Session{}, fmt.Errorf("create user: %w", err)
	}

	if err := s.bindClient(ctx, tx, user.ID, clientID, input.DeviceName); err != nil {
		return Session{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Session{}, fmt.Errorf("commit register tx: %w", err)
	}

	return s.issueSession(user, clientID)
}

func (s *Service) Login(ctx context.Context, input LoginInput, clientID string) (Session, error) {
	input.Email = strings.TrimSpace(strings.ToLower(input.Email))
	input.Password = strings.TrimSpace(input.Password)

	if input.Email == "" || input.Password == "" {
		return Session{}, fmt.Errorf("email and password are required")
	}
	if clientID == "" {
		return Session{}, fmt.Errorf("client ID is required")
	}

	var (
		user User
		hash string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, COALESCE(name, ''), password_hash
		FROM users
		WHERE email = $1
	`, input.Email).Scan(&user.ID, &user.Email, &user.Name, &hash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, fmt.Errorf("load user: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)); err != nil {
		return Session{}, ErrInvalidCredentials
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("begin login tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := s.bindClient(ctx, tx, user.ID, clientID, input.DeviceName); err != nil {
		return Session{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Session{}, fmt.Errorf("commit login tx: %w", err)
	}

	return s.issueSession(user, clientID)
}

func (s *Service) AuthenticateToken(ctx context.Context, rawToken, clientID string) (Principal, error) {
	claims := &tokenClaims{}
	token, err := jwt.ParseWithClaims(rawToken, claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %T", token.Method)
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return Principal{}, ErrUnauthorized
	}

	if strings.TrimSpace(clientID) == "" || claims.ClientID != clientID {
		return Principal{}, ErrUnauthorized
	}

	var principal Principal
	err = s.pool.QueryRow(ctx, `
		SELECT u.id, u.email, COALESCE(u.name, ''), d.client_id
		FROM users u
		JOIN devices d ON d.user_id = u.id
		WHERE u.id = $1 AND d.client_id = $2
	`, claims.Subject, clientID).Scan(&principal.UserID, &principal.Email, &principal.Name, &principal.ClientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrUnauthorized
		}
		return Principal{}, fmt.Errorf("load principal: %w", err)
	}

	if _, err := s.pool.Exec(ctx, `
		UPDATE devices
		SET last_seen_at = NOW()
		WHERE user_id = $1 AND client_id = $2
	`, principal.UserID, clientID); err != nil {
		return Principal{}, fmt.Errorf("refresh device last_seen_at: %w", err)
	}

	return principal, nil
}

func (s *Service) issueSession(user User, clientID string) (Session, error) {
	now := time.Now().UTC()
	expiresAt := now.Add(s.tokenTTL)
	claims := tokenClaims{
		ClientID: clientID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}

	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
	if err != nil {
		return Session{}, fmt.Errorf("sign token: %w", err)
	}

	return Session{
		AccessToken: accessToken,
		ExpiresAt:   expiresAt,
		ClientID:    clientID,
		User:        user,
	}, nil
}

func (s *Service) bindClient(ctx context.Context, tx pgx.Tx, userID, clientID, deviceName string) error {
	var existingUserID string
	err := tx.QueryRow(ctx, `
		SELECT user_id
		FROM devices
		WHERE client_id = $1
	`, clientID).Scan(&existingUserID)
	if err == nil && existingUserID != userID {
		return ErrClientBinding
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load device binding: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO devices (user_id, name, client_id, last_seen_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (client_id)
		DO UPDATE SET
			name = EXCLUDED.name,
			last_seen_at = NOW()
	`, userID, nullableString(strings.TrimSpace(deviceName)), clientID)
	if err != nil {
		return fmt.Errorf("upsert device binding: %w", err)
	}

	return nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}

	return value
}
