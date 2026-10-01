/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import RecipeApp from "./recipe-app.jsx";

const recipe = {
  id: 4,
  ownerId: 8,
  title: "Tomato toast",
  category: "Lunch",
  description: "A simple favorite.",
  ingredients: ["Bread"],
  steps: ["Toast it."],
  images: [],
  ratingCount: 2,
  averageRating: 4.5,
};

afterEach(() => cleanup());

describe("recipe rating interactions", () => {
  it("previews stars with mouse and keyboard and restores the user's rating", async () => {
    let viewerRating = null;
    const fetch = jest.fn((url, options = {}) => {
      if (url === "/api/recipes") return Promise.resolve(jsonResponse({ recipes: [recipe] }));
      if (url === "/api/recipes/4/comments") return Promise.resolve(jsonResponse({ comments: [] }));
      if (url === "/api/recipes/4/ratings" && options.method === "POST") {
        viewerRating = JSON.parse(options.body).rating;
        return Promise.resolve(jsonResponse({
          rating: { rating: viewerRating },
          ratingCount: 3,
          averageRating: 4,
        }));
      }
      if (url === "/api/recipes/4/ratings") {
        return Promise.resolve(jsonResponse({
          ratingCount: viewerRating ? 3 : 2,
          averageRating: viewerRating ? 4 : 4.5,
          viewerRating,
        }));
      }
      return Promise.resolve(jsonResponse({ error: "Not found" }, 404));
    });
    globalThis.fetch = fetch;

    render(<RecipeApp onLogout={jest.fn()} onUnauthorized={jest.fn()} user={{ id: 8, email: "cook@example.com" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /tomato toast/i }));
    expect(await screen.findByText("4.5 out of 5 · 2 ratings")).toBeTruthy();
    expect(screen.getByText("You haven’t rated this recipe yet.")).toBeTruthy();

    const stars = [1, 2, 3, 4, 5].map((value) => screen.getByRole("radio", {
      name: `Rate ${value} ${value === 1 ? "star" : "stars"}`,
    }));
    expect(stars.every((star) => star.textContent === "☆" && star.classList.contains("unselected"))).toBe(true);

    fireEvent.mouseEnter(stars[2]);
    expect(stars.slice(0, 3).every((star) => star.textContent === "★" && star.classList.contains("preview"))).toBe(true);
    expect(stars.slice(3).every((star) => star.textContent === "☆")).toBe(true);
    fireEvent.mouseLeave(stars[2].parentElement);
    expect(stars.every((star) => star.textContent === "☆")).toBe(true);

    fireEvent.focus(stars[0]);
    fireEvent.keyDown(stars[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(stars[1]);
    expect(stars.slice(0, 2).every((star) => star.classList.contains("preview"))).toBe(true);
    fireEvent.click(stars[3]);
    expect(await screen.findByText("Your rating: 4 out of 5")).toBeTruthy();
    expect(await screen.findByText("4.0 out of 5 · 3 ratings")).toBeTruthy();
    expect(stars[3].getAttribute("aria-checked")).toBe("true");
    expect(stars[3].classList.contains("selected")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "← Back to recipes" }));
    fireEvent.click(await screen.findByRole("button", { name: /tomato toast/i }));
    expect(await screen.findByText("Your rating: 4 out of 5")).toBeTruthy();
    expect(await screen.findByText("4.0 out of 5 · 3 ratings")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/recipes/4/ratings",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
