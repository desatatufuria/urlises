import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("marks the active preference's button aria-pressed=true and the others false", () => {
    render(<ThemeToggle preference="dark" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Match system theme" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChange with the matching preference when each button is clicked", () => {
    const onChange = vi.fn();
    render(<ThemeToggle preference="system" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(onChange).toHaveBeenLastCalledWith("light");

    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(onChange).toHaveBeenLastCalledWith("dark");

    fireEvent.click(screen.getByRole("button", { name: "Match system theme" }));
    expect(onChange).toHaveBeenLastCalledWith("system");

    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
