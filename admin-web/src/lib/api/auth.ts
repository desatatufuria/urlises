import { apiRequest } from "./client";
import type { AdminPrincipal, AdminSession, LoginPayload } from "./types";

export function login(input: LoginPayload & { clientId: string }) {
  return apiRequest<AdminSession>("/auth/login", {
    method: "POST",
    clientId: input.clientId,
    body: {
      email: input.email,
      password: input.password,
      deviceName: input.deviceName ?? "Admin Web",
    },
  });
}

export function getMe(token: string) {
  return apiRequest<AdminPrincipal>("/me", { token });
}

export function logout(_token: string) {
  return Promise.resolve();
}
