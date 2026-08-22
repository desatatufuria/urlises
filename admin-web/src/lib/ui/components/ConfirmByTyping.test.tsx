import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmByTyping } from "./ConfirmByTyping";

describe("ConfirmByTyping", () => {
  it("keeps the confirm button disabled on partial, mismatched, or whitespace-only input, and enables it only on an exact case-sensitive match", () => {
    const onConfirm = vi.fn();
    render(<ConfirmByTyping expected="Acme Corp" confirmLabel="Delete organization" onConfirm={onConfirm} />);

    const input = screen.getByRole("textbox");
    const button = screen.getByRole("button", { name: "Delete organization" });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "Acme" } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "acme corp" } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(button).toBeDisabled();

    // Leading/trailing whitespace around an otherwise exact match is
    // trimmed away (value.trim() === expected) — only inner case/character
    // mismatches must block the button.
    fireEvent.change(input, { target: { value: "  Acme Corp  " } });
    expect(button).toBeEnabled();

    fireEvent.change(input, { target: { value: "Acme Corp" } });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
