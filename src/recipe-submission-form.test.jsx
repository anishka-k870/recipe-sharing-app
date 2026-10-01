import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecipeSubmissionForm from "./recipe-submission-form.jsx";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("recipe submission form", () => {
  it("validates each stage and submits uploaded images and recipe fields", async () => {
    const saved = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ image: "/uploads/recipes/12345678-1234-1234-1234-123456789abc.png" }, 201))
      .mockResolvedValueOnce(jsonResponse({
        recipe: {
          id: 7,
          title: "Garden soup",
          category: "Lunch",
          description: "A bright bowl.",
          ingredients: ["Tomatoes"],
          steps: ["Simmer gently."],
          images: ["/uploads/recipes/12345678-1234-1234-1234-123456789abc.png"],
        },
      }, 201));
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    render(<RecipeSubmissionForm onCancel={vi.fn()} onSaved={saved} onUnauthorized={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByText("Add a title of up to 120 characters.")).toBeTruthy();
    expect(screen.getByLabelText("Recipe title").getAttribute("id")).toBe(document.activeElement.id);

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Add a title of up to 120 characters.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Recipe title"), { target: { value: "Garden soup" } });
    fireEvent.change(screen.getByLabelText("Category (optional)"), { target: { value: "Lunch" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A bright bowl." } });
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByText("Add at least one ingredient; each must be at most 200 characters.")).toBeTruthy();
    expect(screen.getByLabelText("Ingredient 1").getAttribute("id")).toBe(document.activeElement.id);

    fireEvent.change(screen.getByLabelText("Ingredient 1"), { target: { value: "Tomatoes" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Simmer gently." } });
    fireEvent.click(screen.getByRole("button", { name: /2 Ingredients & method/ }));
    fireEvent.submit(screen.getByRole("button", { name: /continue/i }).closest("form"));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByLabelText(/recipe images/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/recipe images/i), {
      target: { files: [new File(["png"], "soup.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Uploaded")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/recipes/images");
    expect(screen.getByRole("button", { name: /publish recipe/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish recipe" }));

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/api/recipes/images");
    expect(fetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
    expect(fetch.mock.calls[1][0]).toBe("/api/recipes");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      title: "Garden soup",
      category: "Lunch",
      description: "A bright bowl.",
      ingredients: ["Tomatoes"],
      steps: ["Simmer gently."],
      images: ["/uploads/recipes/12345678-1234-1234-1234-123456789abc.png"],
    });
  });

  it("does not create or update a recipe when the step-two Continue button is activated", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<RecipeSubmissionForm onCancel={vi.fn()} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Recipe title"), { target: { value: "Garden soup" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A bright bowl." } });
    fireEvent.click(screen.getByRole("button", { name: /2 Ingredients & method/ }));
    fireEvent.change(screen.getByLabelText("Ingredient 1"), { target: { value: "Tomatoes" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Simmer gently." } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByLabelText(/recipe images/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish recipe" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
