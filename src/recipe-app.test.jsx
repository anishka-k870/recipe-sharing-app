import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecipeApp from "./recipe-app.jsx";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const recipe = {
  id: 4,
  ownerId: 8,
  title: "Tomato toast",
  category: "Lunch",
  description: "A simple favorite.",
  ingredients: ["Bread", "Tomato"],
  steps: ["Toast the bread.", "Add tomato."],
  images: [],
  ratingCount: 2,
  averageRating: 4.5,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("recipe listing and details", () => {
  it("shows recipe cards, applies search filters, and opens recipe details", async () => {
    const fetch = vi.fn((url, options = {}) => {
      if (url === "/api/recipes" || url.startsWith("/api/recipes?")) {
        return Promise.resolve(jsonResponse({ recipes: [recipe] }));
      }
      if (url.startsWith("/api/recipes/4/comments")) {
        return Promise.resolve(jsonResponse(options.method === "POST"
          ? { comment: { id: 3, userId: 8, text: JSON.parse(options.body).text } }
          : { comments: [] }));
      }
      if (url.startsWith("/api/recipes/4/ratings")) {
        return Promise.resolve(jsonResponse({ recipeId: 4, ratingCount: 2, averageRating: 4.5 }));
      }
      return Promise.resolve(jsonResponse({ error: "Not found" }, 404));
    });
    vi.stubGlobal("fetch", fetch);

    render(<RecipeApp onLogout={vi.fn()} onUnauthorized={vi.fn()} user={{ id: 8, email: "cook@example.com" }} />);
    const wordmark = screen.getByRole("banner").querySelector(".wordmark");
    expect(wordmark).toBeTruthy();
    wordmark.focus();
    expect(document.activeElement).toBe(wordmark);
    expect(await screen.findByText("Tomato toast")).toBeTruthy();
    expect(screen.getByText("★ 4.5 · 2 ratings")).toBeTruthy();
    const filters = screen.getByRole("button", { name: "Search recipes" }).closest("form");
    expect(filters.querySelector(".filter-fields").contains(screen.getByLabelText("Category"))).toBe(true);
    expect(filters.querySelector(".filter-fields").contains(screen.getByLabelText("Ingredient"))).toBe(true);
    expect(filters.querySelector(".filter-actions").contains(screen.getByRole("button", { name: "Search recipes" }))).toBe(true);
    expect(filters.querySelector(".filter-fields").compareDocumentPosition(filters.querySelector(".filter-actions"))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ingredient"), { target: { value: "tomato" } });
    fireEvent.submit(screen.getByRole("button", { name: "Search recipes" }).closest("form"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/recipes?ingredient=tomato",
      expect.objectContaining({ credentials: "same-origin" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: /tomato toast/i }));
    expect(await screen.findByRole("heading", { name: "Ingredients" })).toBeTruthy();
    expect(screen.getByText("Toast the bread.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit recipe" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Rate 5 stars" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/recipes/4/ratings",
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "Very tasty." } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByText("Very tasty.")).toBeTruthy();
  });

  it("prepopulates the edit form and deletes an owned recipe through the API", async () => {
    let deleted = false;
    const fetch = vi.fn((url, options = {}) => {
      if (url === "/api/recipes" || url.startsWith("/api/recipes?")) {
        return Promise.resolve(jsonResponse({ recipes: deleted ? [] : [recipe] }));
      }
      if (url.startsWith("/api/recipes/4/comments")) return Promise.resolve(jsonResponse({ comments: [] }));
      if (url.startsWith("/api/recipes/4/ratings")) {
        return Promise.resolve(jsonResponse({ recipeId: 4, ratingCount: 2, averageRating: 4.5 }));
      }
      if (url === "/api/recipes/4" && options.method === "DELETE") {
        deleted = true;
        return Promise.resolve({ ok: true, status: 204 });
      }
      return Promise.resolve(jsonResponse({ error: "Not found" }, 404));
    });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<RecipeApp onLogout={vi.fn()} onUnauthorized={vi.fn()} user={{ id: 8, email: "cook@example.com" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /tomato toast/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit recipe" }));
    expect(screen.getByRole("heading", { name: "Edit recipe" })).toBeTruthy();
    expect(screen.getByLabelText("Recipe title").value).toBe("Tomato toast");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No recipes found. Try another search or share the first one.")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/recipes/4", expect.objectContaining({ method: "DELETE" }));
    expect(window.confirm).toHaveBeenCalled();
  });
});
