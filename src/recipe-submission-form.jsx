import { useEffect, useRef, useState } from "react";

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const STEPS = ["Recipe details", "Ingredients & method", "Images & review"];

function checkStep(step, values, existingImages, newImages) {
  if (step === 0) {
    const errors = {};
    if (!values.title.trim() || values.title.trim().length > 120) {
      errors.title = "Add a title of up to 120 characters.";
    }
    if (!values.description.trim() || values.description.trim().length > 2000) {
      errors.description = "Add a description of up to 2000 characters.";
    }
    if (values.category.trim().length > 80) errors.category = "Category must be at most 80 characters.";
    return errors;
  }
  if (step === 1) {
    const errors = {};
    if (!values.ingredients.length || values.ingredients.some((item) => !item.trim() || item.trim().length > 200)) {
      errors.ingredients = "Add at least one ingredient; each must be at most 200 characters.";
    }
    if (!values.steps.length || values.steps.some((item) => !item.trim() || item.trim().length > 1000)) {
      errors.steps = "Add at least one method step; each must be at most 1000 characters.";
    }
    return errors;
  }
  const errors = {};
  if (existingImages.length + newImages.length > MAX_IMAGES) {
    errors.images = `Choose no more than ${MAX_IMAGES} images in total.`;
  } else if (newImages.some((image) => {
    const file = image.file || image;
    return !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES;
  })) {
    errors.images = "Images must be JPEG, PNG, or WebP files no larger than 5 MB each.";
  }
  return errors;
}

async function readResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

export default function RecipeSubmissionForm({ recipe, onSaved, onCancel, onUnauthorized }) {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(recipe?.title || "");
  const [category, setCategory] = useState(recipe?.category || "");
  const [description, setDescription] = useState(recipe?.description || "");
  const [ingredients, setIngredients] = useState(recipe?.ingredients || [""]);
  const [steps, setSteps] = useState(recipe?.steps || [""]);
  const [existingImages, setExistingImages] = useState(recipe?.images || []);
  const [newImages, setNewImages] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const uploadedImages = useRef(new Map());
  const values = { title, category, description, ingredients, steps };

  useEffect(() => {
    const filePreviews = newImages.map(({ file }) => ({
      file,
      url: URL.createObjectURL(file),
    }));
    setPreviews(filePreviews);
    return () => filePreviews.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [newImages]);

  function updateArray(setArray, index, value) {
    setArray((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
  }

  function continueToNextStep() {
    goToStep(Math.min(step + 1, STEPS.length - 1));
  }

  function goToStep(destination) {
    setMessage("");
    for (let index = 0; index < destination; index += 1) {
      const nextErrors = checkStep(index, values, existingImages, newImages);
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        setStep(index);
        const firstField = {
          title: "recipe-title",
          category: "recipe-category",
          description: "recipe-description",
          ingredients: "ingredient-0",
          steps: "step-0",
        }[Object.keys(nextErrors)[0]];
        if (firstField) requestAnimationFrame(() => document.getElementById(firstField)?.focus());
        return;
      }
    }
    setErrors({});
    setStep(destination);
  }

  function selectImages(event) {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    const nextErrors = checkStep(2, values, existingImages, [...newImages, ...selected]);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors((current) => ({ ...current, images: undefined }));
    const queued = selected.map((file) => ({ file, path: null, status: "uploading", error: "" }));
    setNewImages((current) => [...current, ...queued]);
    queued.forEach((image) => uploadSelectedImage(image.file));
  }

  async function uploadImage(file) {
    const cachedPath = uploadedImages.current.get(file);
    if (cachedPath) return cachedPath;

    const formData = new FormData();
    formData.append("image", file);
    const result = await readResponse(await fetch("/api/recipes/images", {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    }));
    uploadedImages.current.set(file, result.image);
    return result.image;
  }

  async function uploadSelectedImage(file) {
    try {
      const path = await uploadImage(file);
      setNewImages((current) => current.map((image) => image.file === file
        ? { ...image, path, status: "uploaded", error: "" }
        : image));
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      setNewImages((current) => current.map((image) => image.file === file
        ? { ...image, status: "error", error: requestError.message }
        : image));
    }
  }

  async function save(event) {
    event.preventDefault();
    if (step !== STEPS.length - 1 || submitting) return;
    for (let index = 0; index < STEPS.length; index += 1) {
      const stageErrors = checkStep(index, values, existingImages, newImages);
      if (Object.keys(stageErrors).length > 0) {
        setErrors(stageErrors);
        setStep(index);
        const firstField = {
          title: "recipe-title",
          category: "recipe-category",
          description: "recipe-description",
          ingredients: "ingredient-0",
          steps: "step-0",
          images: "recipe-images",
        }[Object.keys(stageErrors)[0]];
        if (firstField) requestAnimationFrame(() => document.getElementById(firstField)?.focus());
        return;
      }
    }
    if (newImages.some((image) => image.status === "uploading")) {
      setMessage("Please wait for the selected images to finish uploading.");
      return;
    }
    if (newImages.some((image) => image.status === "error" || !image.path)) {
      setErrors({ images: "An image could not be uploaded. Remove it and try again." });
      return;
    }

    setSubmitting(true);
    setMessage("");

    const payload = {
      title: title.trim(),
      category: category.trim(),
      description: description.trim(),
      ingredients: ingredients.map((item) => item.trim()),
      steps: steps.map((item) => item.trim()),
      images: [...existingImages, ...newImages.map((image) => image.path)],
    };
    try {
      const result = await readResponse(await fetch(
        recipe ? `/api/recipes/${recipe.id}` : "/api/recipes",
        {
          method: recipe ? "PUT" : "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      ));
      uploadedImages.current.clear();
      onSaved(result.recipe);
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      setMessage(requestError.message || "Unable to save this recipe. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="recipe-form-panel" aria-labelledby="recipe-form-title">
      <div className="recipe-form-header">
        <div>
          <p className="eyebrow">{recipe ? "Make it your own" : "Share something delicious"}</p>
          <h2 id="recipe-form-title">{recipe ? "Edit recipe" : "Add a recipe"}</h2>
        </div>
        <button className="text-button" onClick={onCancel} type="button">Cancel</button>
      </div>

      <ol className="step-indicator" aria-label="Recipe form steps">
        {STEPS.map((label, index) => (
          <li aria-current={step === index ? "step" : undefined} className={step >= index ? "active" : ""} key={label}>
            <button
              aria-current={step === index ? "step" : undefined}
              className="step-button"
              disabled={submitting}
              onClick={() => goToStep(index)}
              type="button"
            >
              <span>{index + 1}</span>{label}
            </button>
          </li>
        ))}
      </ol>

      <form onSubmit={(event) => event.preventDefault()} noValidate>
        {step === 0 && (
          <div className="recipe-step">
            <label htmlFor="recipe-title">Recipe title</label>
            <input
              autoFocus
              id="recipe-title"
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
            {errors.title && <p className="field-error">{errors.title}</p>}

            <label htmlFor="recipe-category">Category <span>(optional)</span></label>
            <input
              id="recipe-category"
              maxLength={80}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="e.g. Dinner"
              value={category}
            />
            {errors.category && <p className="field-error">{errors.category}</p>}

            <label htmlFor="recipe-description">Description</label>
            <textarea
              id="recipe-description"
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              value={description}
            />
            {errors.description && <p className="field-error">{errors.description}</p>}
          </div>
        )}

        {step === 1 && (
          <div className="recipe-step">
            <div className="list-field">
              <div className="list-field-heading">
                <label>Ingredients</label>
                <button
                  className="small-button"
                  onClick={() => setIngredients((current) => [...current, ""])}
                  type="button"
                >+ Add ingredient</button>
              </div>
              {ingredients.map((ingredient, index) => (
                <div className="editable-row" key={`ingredient-${index}`}>
                  <input
                    aria-label={`Ingredient ${index + 1}`}
                    id={`ingredient-${index}`}
                    maxLength={200}
                    onChange={(event) => updateArray(setIngredients, index, event.target.value)}
                    value={ingredient}
                  />
                  <button
                    aria-label={`Remove ingredient ${index + 1}`}
                    className="remove-button"
                    onClick={() => setIngredients((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    type="button"
                  >×</button>
                </div>
              ))}
              {errors.ingredients && <p className="field-error">{errors.ingredients}</p>}
            </div>

            <div className="list-field">
              <div className="list-field-heading">
                <label>Method</label>
                <button
                  className="small-button"
                  onClick={() => setSteps((current) => [...current, ""])}
                  type="button"
                >+ Add step</button>
              </div>
              {steps.map((item, index) => (
                <div className="editable-row" key={`step-${index}`}>
                  <textarea
                    aria-label={`Step ${index + 1}`}
                    id={`step-${index}`}
                    maxLength={1000}
                    onChange={(event) => updateArray(setSteps, index, event.target.value)}
                    rows={2}
                    value={item}
                  />
                  <button
                    aria-label={`Remove step ${index + 1}`}
                    className="remove-button"
                    onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    type="button"
                  >×</button>
                </div>
              ))}
              {errors.steps && <p className="field-error">{errors.steps}</p>}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="recipe-step">
            <label htmlFor="recipe-images">Recipe images <span>(JPEG, PNG, or WebP; up to 5 MB each)</span></label>
            <input
              accept="image/jpeg,image/png,image/webp"
              id="recipe-images"
              multiple
              onChange={selectImages}
              type="file"
            />
            {errors.images && <p className="field-error">{errors.images}</p>}
            <div className="image-preview-grid">
              {existingImages.map((image, index) => (
                <div className="image-preview" key={`${image}-${index}`}>
                  <img alt={`Recipe image ${index + 1}`} src={image} />
                  <button
                    aria-label={`Remove image ${index + 1}`}
                    className="remove-button"
                    onClick={() => setExistingImages((current) => current.filter((_, imageIndex) => imageIndex !== index))}
                    type="button"
                  >×</button>
                </div>
              ))}
              {previews.map(({ file, url }, index) => {
                const image = newImages.find((candidate) => candidate.file === file);
                return (
                <div className="image-preview" key={`${file.name}-${file.lastModified}-${index}`}>
                  <img alt={`New recipe image ${index + 1}`} src={url} />
                  <span className={`image-upload-status ${image.status}`} role="status">
                    {image.status === "uploading" ? "Uploading…" : image.status === "error" ? image.error || "Upload failed" : "Uploaded"}
                  </span>
                  <button
                    aria-label={`Remove new image ${index + 1}`}
                    className="remove-button"
                    disabled={submitting}
                    onClick={() => setNewImages((current) => current.filter((item) => item.file !== file))}
                    type="button"
                  >×</button>
                </div>
                );
              })}
            </div>
            <div className="recipe-review">
              <p><strong>{title.trim()}</strong>{category.trim() && <span> · {category.trim()}</span>}</p>
              <p>{description.trim()}</p>
              <p>{ingredients.filter((item) => item.trim()).length} ingredients · {steps.filter((item) => item.trim()).length} steps</p>
            </div>
          </div>
        )}

        <div className="recipe-form-actions">
          {step > 0 && <button className="secondary-button" disabled={submitting} onClick={() => setStep((current) => current - 1)} type="button">Back</button>}
          {step < STEPS.length - 1
            ? <button className="primary-button" onClick={continueToNextStep} type="button">Continue <span aria-hidden="true">→</span></button>
            : <button className="primary-button" disabled={submitting || newImages.some((image) => image.status === "uploading")} onClick={save} type="button">{submitting ? "Saving recipe…" : recipe ? "Save changes" : "Publish recipe"}</button>}
        </div>
        <p aria-live="polite" className="message error" role="alert">{message}</p>
      </form>
    </section>
  );
}

export { checkStep };
