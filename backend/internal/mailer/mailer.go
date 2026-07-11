package mailer

import (
	"context"
	"errors"
)

var ErrDisabled = errors.New("mail delivery is disabled")

type Mailer interface {
	Send(context.Context, Message) error
}

type Message struct {
	To          []string
	Subject     string
	Text        string
	HTML        string
	DisplayName string
	ReplyTo     string
}
