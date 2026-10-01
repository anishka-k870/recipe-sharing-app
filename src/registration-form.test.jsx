import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RegistrationForm from "./registration-form.jsx";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser authentication", () => {
  it("logs in through the cookie session and opens the recipe list", async () => {
    const fetch = vi.fn((url, options = {}) => {
      if (url === "/api/auth/session" && !options.method) {
        return Promise.resolve(jsonResponse({ error: "Authentication required." }, 401));
      }
      if (url === "/api/auth/session" && options.method === "POST") {
        return Promise.resolve(jsonResponse({ user: { id: 8, email: "cook@example.com" }, expiresIn: 3600 }));
      }
      if (url === "/api/recipes") return Promise.resolve(jsonResponse({ recipes: [] }));
      return Promise.resolve(jsonResponse({ error: "Not found" }, 404));
    });
    vi.stubGlobal("fetch", fetch);

    render(<RegistrationForm />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "cook@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "good-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Recipes worth sharing." })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/recipes", expect.objectContaining({
      credentials: "same-origin",
    })));
  });
});
