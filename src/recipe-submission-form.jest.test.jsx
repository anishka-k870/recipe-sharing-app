/** @jest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import RecipeSubmissionForm from "./recipe-submission-form.jsx";

afterEach(() => {
  cleanup();
});

describe("recipe editor stage navigation", () => {
  it("lets users click Images & review while validating prior stages and focusing errors", async () => {
    render(
      <RecipeSubmissionForm
        onCancel={jest.fn()}
        onSaved={jest.fn()}
        onUnauthorized={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByText("Add a title of up to 120 characters.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement.id).toBe("recipe-title"));
    expect(screen.queryByLabelText(/recipe images/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Recipe title"), { target: { value: "Garden soup" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A bright bowl." } });
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByText("Add at least one ingredient; each must be at most 200 characters.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement.id).toBe("ingredient-0"));
    expect(screen.queryByLabelText(/recipe images/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Ingredient 1"), { target: { value: "Tomatoes" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Simmer gently." } });
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByLabelText(/recipe images/i)).toBeTruthy();
  });
});
