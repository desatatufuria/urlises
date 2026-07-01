FROM golang:1.26 AS build

WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/. ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./cmd/api

FROM alpine:3.20

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY --from=build /out/api /usr/local/bin/api
COPY --from=build /src/migrations ./migrations

ENV APP_ROOT=/app

EXPOSE 8081

CMD ["api"]
