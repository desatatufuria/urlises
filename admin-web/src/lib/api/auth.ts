import { apiRequest } from "./client";
import type { AdminPrincipal, AdminSession, LoginPayload, RegistrationPayload } from "./types";

export function getSetupStatus() {
  return apiRequest<{ required: boolean }>("/setup/status");
}

export function register(input: RegistrationPayload & { clientId: string }) {
  return apiRequest<AdminSession>("/auth/register", {
    method: "POST",
    clientId: input.clientId,
    body: {
      email: input.email,
      name: input.name,
      password: input.password,
      deviceName: input.deviceName ?? "URLises Control",
      ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
    },
  });
}

export function login(input: LoginPayload & { clientId: string }) {
  return apiRequest<AdminSession>("/auth/login", {
    method: "POST",
    clientId: input.clientId,
    body: {
      email: input.email,
      password: input.password,
      deviceName: input.deviceName ?? "URLises Control",
    },
  });
}

export function getMe(token: string) {
  return apiRequest<AdminPrincipal>("/me", { token });
}

export function logout(_token: string) {
  return Promise.resolve();
}

export function deactivateSelf(token: string) {
  return apiRequest<void>("/me/deactivate", {
    method: "POST",
    token,
  });
}
