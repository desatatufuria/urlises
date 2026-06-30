# Define the Go image version as a build argument
ARG GO_IMAGE_VERSION=1.26.4-bookworm

FROM docker.io/golang:${GO_IMAGE_VERSION}

# Define build arguments
ARG USERNAME=furia
ARG USER_ID=1000
ARG GROUP_ID=1000

ARG DOCKER_COMPOSE_VERSION=v5.0.2
ARG AIR_VERSION=v1.64.4
ARG GO_DELVE_VERSION=v1.26.0
ARG GOPLS_VERSION=v0.21.0
ARG STATICCHECK_VERSION=2025.1.1

# Install necessary packages (APT en Debian)
RUN apt-get update && apt-get install -y \
    sudo git bash build-essential curl jq openssh-client \
    docker.io nano nodejs npm sqlite3 libsqlite3-dev \
    chromium fonts-freefont-ttf fonts-noto ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI plugins
RUN mkdir -p /usr/local/lib/docker/cli-plugins/

# Install Docker Compose
RUN curl -SL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Create user
RUN groupadd -g ${GROUP_ID} ${USERNAME} \
    && useradd -m -u ${USER_ID} -g ${GROUP_ID} -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && usermod -aG sudo ${USERNAME} \
    && mkdir -p /workspace /go \
    && chown -R ${USER_ID}:${GROUP_ID} /workspace /go

# Install Go tools
RUN go install github.com/air-verse/air@${AIR_VERSION} \
    && go install github.com/go-delve/delve/cmd/dlv@${GO_DELVE_VERSION} \
    && go install golang.org/x/tools/gopls@${GOPLS_VERSION} \
    && go install honnef.co/go/tools/cmd/staticcheck@${STATICCHECK_VERSION}

# Ensure Go bin in PATH
ENV PATH="/go/bin:${PATH}"

# Switch to user
USER ${USERNAME}
WORKDIR /home/${USERNAME}

ENV PATH="/home/${USERNAME}/.local/bin:${PATH}"

EXPOSE 8095

CMD ["air"]
