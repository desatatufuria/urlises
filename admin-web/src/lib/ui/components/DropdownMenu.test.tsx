import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DropdownMenu } from "./DropdownMenu";

function renderMenu() {
  return render(
    <div>
      <DropdownMenu label="Menu">{(close) => <button type="button" onClick={close}>Item</button>}</DropdownMenu>
      <button type="button">Outside</button>
    </div>,
  );
}

describe("DropdownMenu", () => {
  it("is closed by default", () => {
    renderMenu();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on trigger click", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on outside click", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes when a menu item inside is clicked", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    await user.click(screen.getByRole("button", { name: "Item" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
