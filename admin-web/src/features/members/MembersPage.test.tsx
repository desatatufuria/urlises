import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("members page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows calm empty states for members and invitations", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({ members: [] });
      }
      if (url.endsWith("/organizations/org-1/invitations")) {
        return jsonResponse({ invitations: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/members");

    expect(await screen.findByText(/no members yet/i)).toBeInTheDocument();
    expect(await screen.findByText(/no pending invitations/i)).toBeInTheDocument();
  });

  it("opens the invitation panel from People and closes it through URL history", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [] });
      if (url.endsWith("/organizations/org-1/invitations")) return jsonResponse({ invitations: [] });
      return jsonResponse({ error: "not found" }, 404);
    });
    const user = userEvent.setup();
    const { router } = renderAppRoute("/members");
    const inviteButton = await screen.findByRole("button", { name: /invite person/i });
    await user.click(inviteButton);
    expect(screen.getByRole("dialog", { name: /invite person/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close panel/i })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: /invite member/i })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /close panel/i })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(inviteButton).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: /invite person/i })).not.toBeInTheDocument();
    await user.click(inviteButton);
    await act(() => router.navigate(-1));
    expect(screen.queryByRole("dialog", { name: /invite person/i })).not.toBeInTheDocument();
  });

  it("shows a failed page query and retries it successfully", async () => {
    let memberAttempts = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/members")) {
        memberAttempts += 1;
        return memberAttempts === 1 ? jsonResponse({ error: "offline" }, 503) : jsonResponse({ members: [] });
      }
      if (url.endsWith("/organizations/org-1/invitations")) return jsonResponse({ invitations: [] });
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/members");
    expect(await screen.findByText(/members could not be loaded/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry members/i }));
    expect(await screen.findByText(/no members yet/i)).toBeInTheDocument();
  });

  it("records a new invitation and refreshes the pending list", async () => {
    const invitations: Array<Record<string, unknown>> = [];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({
          members: [{ userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" }],
        });
      }

      if (url.endsWith("/organizations/org-1/invitations") && method === "GET") {
        return jsonResponse({ invitations });
      }

      if (url.endsWith("/organizations/org-1/invitations") && method === "POST") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { email: string; role: string };
        const invitation = {
          id: "invite-1",
          organizationId: "org-1",
          email: payload.email,
          role: payload.role,
          status: "pending",
          invitedByUserId: "user-1",
          invitedByEmail: "owner@example.com",
          createdAt: "2026-07-03T22:00:00Z",
          expiresAt: "2026-07-10T22:00:00Z",
        };
        invitations.splice(0, invitations.length, invitation);
        return jsonResponse(invitation, 201);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/members");

    await screen.findByText(/active members/i);
    await userEvent.click(screen.getByRole("button", { name: /invite person/i }));

    await userEvent.type(screen.getByLabelText(/invite email/i), "new-admin@example.com");
    await userEvent.selectOptions(screen.getByLabelText(/invite role/i), "admin");
    await userEvent.click(screen.getByRole("button", { name: /invite member/i }));

    expect(await screen.findByText(/invitation queued/i)).toBeInTheDocument();
    expect(await screen.findByText("new-admin@example.com")).toBeInTheDocument();
    expect(screen.getByText(/sent by owner@example.com/i)).toBeInTheDocument();
  });

  it("keeps the previous role visible when the backend rejects a role change", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/members") && method === "GET") {
        return jsonResponse({
          members: [{ userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" }],
        });
      }

      if (url.endsWith("/organizations/org-1/invitations")) {
        return jsonResponse({ invitations: [] });
      }

      if (url.endsWith("/organizations/org-1/members") && method === "PATCH") {
        return jsonResponse({ error: "last owner cannot be removed or demoted" }, 409);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/members");

    const select = await screen.findByLabelText(/role for owner@example.com/i);
    expect(select).toHaveValue("owner");

    await userEvent.selectOptions(select, "admin");

    expect(await screen.findByText(/role update rejected/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/role for owner@example.com/i)).toHaveValue("owner"));
  });

  it("resends a pending invitation and shows a confirmation notice", async () => {
    const invitation = {
      id: "invite-1",
      organizationId: "org-1",
      email: "pending@example.com",
      role: "member",
      status: "pending",
      invitedByUserId: "user-1",
      invitedByEmail: "owner@example.com",
      createdAt: "2026-07-03T22:00:00Z",
      expiresAt: "2026-07-10T22:00:00Z",
    };
    let resendCalls = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({ members: [] });
      }
      if (url.endsWith("/organizations/org-1/invitations") && method === "GET") {
        return jsonResponse({ invitations: [invitation] });
      }
      if (url.endsWith("/organizations/org-1/invitations/invite-1/resend") && method === "POST") {
        resendCalls += 1;
        return jsonResponse({ ...invitation, expiresAt: "2026-07-17T22:00:00Z" });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/members");

    await screen.findByText("pending@example.com");
    await userEvent.click(screen.getByRole("button", { name: /resend invitation to pending@example.com/i }));

    expect(await screen.findByText(/invitation resent/i)).toBeInTheDocument();
    expect(resendCalls).toBe(1);
  });

  it("shows an error notice when resending an invitation fails", async () => {
    const invitation = {
      id: "invite-2",
      organizationId: "org-1",
      email: "stuck@example.com",
      role: "member",
      status: "pending",
      invitedByUserId: "user-1",
      invitedByEmail: "owner@example.com",
      createdAt: "2026-07-03T22:00:00Z",
      expiresAt: "2026-07-10T22:00:00Z",
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({ members: [] });
      }
      if (url.endsWith("/organizations/org-1/invitations") && method === "GET") {
        return jsonResponse({ invitations: [invitation] });
      }
      if (url.endsWith("/organizations/org-1/invitations/invite-2/resend") && method === "POST") {
        return jsonResponse({ error: "invitation is not pending" }, 400);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/members");

    await screen.findByText("stuck@example.com");
    await userEvent.click(screen.getByRole("button", { name: /resend invitation to stuck@example.com/i }));

    expect(await screen.findByText(/resend failed/i)).toBeInTheDocument();
  });

  it("revokes the current operator shell immediately after self-demotion", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/organizations/org-1/members") && method === "GET") return jsonResponse({ members: [{ userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" }] });
      if (url.endsWith("/organizations/org-1/invitations")) return jsonResponse({ invitations: [] });
      if (url.endsWith("/organizations/org-1/members") && method === "PATCH") return jsonResponse({ userId: "user-1", email: "owner@example.com", role: "member" });
      if (url.endsWith("/organizations") && method === "GET") return jsonResponse({ organizations: [{ organizationId: "org-1", organizationName: "Acme", role: "member" }] });
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/members");
    await userEvent.selectOptions(await screen.findByLabelText(/role for owner@example.com/i), "member");
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });
});
