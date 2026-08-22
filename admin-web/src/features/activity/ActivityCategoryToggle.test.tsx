import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityCategoryToggle } from "./ActivityCategoryToggle";

describe("ActivityCategoryToggle", () => {
  it("marks the active category's button aria-pressed=true and the others false", () => {
    render(<ActivityCategoryToggle category="administrative" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Administrative" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bookmarks" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onChange with the matching category when each button is clicked", () => {
    const onChange = vi.fn();
    render(<ActivityCategoryToggle category="all" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(onChange).toHaveBeenLastCalledWith("bookmarks");

    fireEvent.click(screen.getByRole("button", { name: "Administrative" }));
    expect(onChange).toHaveBeenLastCalledWith("administrative");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenLastCalledWith("all");

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("exposes the group as an accessible, labeled group of buttons", () => {
    render(<ActivityCategoryToggle category="bookmarks" onChange={vi.fn()} />);

    expect(screen.getByRole("group", { name: "Activity category" })).toBeInTheDocument();
  });
});
