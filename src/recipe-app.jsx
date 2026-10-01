import { useCallback, useEffect, useRef, useState } from "react";
import RecipeSubmissionForm from "./recipe-submission-form.jsx";

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function errorText(error) {
  return error.message || "Please try again.";
}

export default function RecipeApp({ user, onLogout, onUnauthorized }) {
  const [recipes, setRecipes] = useState([]);
  const [filters, setFilters] = useState({ category: "", ingredient: "" });
  const [activeFilters, setActiveFilters] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [editor, setEditor] = useState(null);
  const [comments, setComments] = useState([]);
  const [ratingSummary, setRatingSummary] = useState({ averageRating: null, ratingCount: 0 });
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [commentText, setCommentText] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const loadRecipes = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams();
    if (activeFilters.category) query.set("category", activeFilters.category);
    if (activeFilters.ingredient) query.set("ingredient", activeFilters.ingredient);
    try {
      const result = await requestJson(`/api/recipes${query.size ? `?${query}` : ""}`);
      setRecipes(result.recipes);
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      else setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, [activeFilters, onUnauthorized]);

  useEffect(() => {
    loadRecipes();
  }, [loadRecipes]);

  useEffect(() => {
    if (!selectedRecipe) return undefined;
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    Promise.all([
      requestJson(`/api/recipes/${selectedRecipe.id}/comments`),
      requestJson(`/api/recipes/${selectedRecipe.id}/ratings`),
    ]).then(([commentResult, ratingResult]) => {
      if (!active) return;
      setComments(commentResult.comments);
      setRatingSummary(ratingResult);
    }).catch((requestError) => {
      if (!active) return;
      if (requestError.status === 401) onUnauthorized();
      else setDetailError(errorText(requestError));
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [selectedRecipe, onUnauthorized]);

  function applyFilters(event) {
    event.preventDefault();
    setActiveFilters({
      category: filters.category.trim(),
      ingredient: filters.ingredient.trim(),
    });
    setSelectedRecipe(null);
    setNotice("");
  }

  function handleSaved(savedRecipe) {
    setEditor(null);
    setSelectedRecipe(savedRecipe);
    setNotice("Recipe saved successfully.");
    loadRecipes();
  }

  async function deleteRecipe() {
    if (!selectedRecipe || !window.confirm(`Delete "${selectedRecipe.title}"? This cannot be undone.`)) return;
    setDeleteSubmitting(true);
    setDetailError("");
    try {
      await requestJson(`/api/recipes/${selectedRecipe.id}`, { method: "DELETE" });
      setSelectedRecipe(null);
      setNotice("Recipe deleted.");
      await loadRecipes();
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      else setDetailError(errorText(requestError));
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    const text = commentText.trim();
    if (!text || text.length > 2000) {
      setDetailError("Write a comment of up to 2000 characters.");
      return;
    }
    setCommentSubmitting(true);
    setDetailError("");
    try {
      const result = await requestJson(`/api/recipes/${selectedRecipe.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setComments((current) => [...current, result.comment]);
      setCommentText("");
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      else setDetailError(errorText(requestError));
    } finally {
      setCommentSubmitting(false);
    }
  }

  async function submitRating(rating) {
    setRatingSubmitting(true);
    setDetailError("");
    try {
      const result = await requestJson(`/api/recipes/${selectedRecipe.id}/ratings`, {
        method: "POST",
        body: JSON.stringify({ rating }),
      });
      setRatingSummary({ ...result, viewerRating: result.rating.rating });
      setRecipes((current) => current.map((recipe) => recipe.id === selectedRecipe.id
        ? { ...recipe, ratingCount: result.ratingCount, averageRating: result.averageRating }
        : recipe));
    } catch (requestError) {
      if (requestError.status === 401) onUnauthorized();
      else setDetailError(errorText(requestError));
    } finally {
      setRatingSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="wordmark" onClick={() => { setSelectedRecipe(null); setEditor(null); }} type="button">
          the recipe table
        </button>
        <div className="account-actions">
          <span>{user.email}</span>
          <button className="text-button" onClick={onLogout} type="button">Sign out</button>
        </div>
      </header>

      <div className="app-content">
        {editor ? (
          <RecipeSubmissionForm
            onCancel={() => setEditor(null)}
            onSaved={handleSaved}
            onUnauthorized={onUnauthorized}
            recipe={editor.recipe}
          />
        ) : selectedRecipe ? (
          <RecipeDetails
            comments={comments}
            commentSubmitting={commentSubmitting}
            commentText={commentText}
            deleteSubmitting={deleteSubmitting}
            detailError={detailError}
            detailLoading={detailLoading}
            onBack={() => setSelectedRecipe(null)}
            onCommentChange={setCommentText}
            onDelete={deleteRecipe}
            onEdit={() => setEditor({ recipe: selectedRecipe })}
            onRating={submitRating}
            onSubmitComment={submitComment}
            onUnauthorized={onUnauthorized}
            ratingSummary={ratingSummary}
            ratingSubmitting={ratingSubmitting}
            recipe={selectedRecipe}
            userId={user.id}
          />
        ) : (
          <>
            <section className="dashboard-heading">
              <div>
                <p className="eyebrow">Gather around</p>
                <h1>Recipes worth sharing.</h1>
                <p>Find a new favorite, or add your own to the table.</p>
              </div>
              <button className="primary-button" onClick={() => setEditor({ recipe: null })} type="button">
                + Add a recipe
              </button>
            </section>

            <form className="filter-bar" onSubmit={applyFilters}>
              <div className="filter-fields">
                <label>
                  Category
                  <input
                    maxLength={80}
                    onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
                    placeholder="e.g. Dinner"
                    value={filters.category}
                  />
                </label>
                <label>
                  Ingredient
                  <input
                    maxLength={100}
                    onChange={(event) => setFilters((current) => ({ ...current, ingredient: event.target.value }))}
                    placeholder="e.g. tomato"
                    value={filters.ingredient}
                  />
                </label>
              </div>
              <div className="filter-actions">
                {(activeFilters.category || activeFilters.ingredient) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setFilters({ category: "", ingredient: "" });
                      setActiveFilters({});
                    }}
                    type="button"
                  >Clear filters</button>
                )}
                <button className="secondary-button" type="submit">Search recipes</button>
              </div>
            </form>

            {notice && <p className="notice" role="status">{notice}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {loading ? (
              <p className="empty-state" role="status">Gathering recipes…</p>
            ) : error ? null : recipes.length === 0 ? (
              <p className="empty-state">No recipes found. Try another search or share the first one.</p>
            ) : (
              <section className="recipe-grid" aria-label="Recipes">
                {recipes.map((recipe) => (
                  <article className="recipe-card" key={recipe.id}>
                    <button className="recipe-card-open" onClick={() => setSelectedRecipe(recipe)} type="button">
                      {recipe.images[0]
                        ? <img alt="" className="recipe-card-image" src={recipe.images[0]} />
                        : <div aria-hidden="true" className="recipe-card-placeholder">✳</div>}
                      <span className="recipe-card-copy">
                        <span className="recipe-category">{recipe.category || "From the community"}</span>
                        <strong>{recipe.title}</strong>
                        <span className="recipe-description">{recipe.description}</span>
                        <span className="recipe-rating">
                          {recipe.averageRating === null
                            ? "Not rated yet"
                            : `★ ${Number(recipe.averageRating).toFixed(1)} · ${recipe.ratingCount} ${recipe.ratingCount === 1 ? "rating" : "ratings"}`}
                        </span>
                      </span>
                    </button>
                    {recipe.ownerId === user.id && (
                      <button className="card-edit-button" onClick={() => setEditor({ recipe })} type="button">
                        Edit your recipe
                      </button>
                    )}
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function RecipeDetails({
  comments,
  commentSubmitting,
  commentText,
  deleteSubmitting,
  detailError,
  detailLoading,
  onBack,
  onCommentChange,
  onDelete,
  onEdit,
  onRating,
  onSubmitComment,
  ratingSummary,
  ratingSubmitting,
  recipe,
  userId,
}) {
  const [hoveredRating, setHoveredRating] = useState(null);
  const [focusedRating, setFocusedRating] = useState(null);
  const ratingButtons = useRef([]);
  const viewerRating = ratingSummary.viewerRating ?? null;
  const previewRating = hoveredRating ?? focusedRating;

  function moveRatingFocus(event, value) {
    let nextValue;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextValue = Math.min(value + 1, 5);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextValue = Math.max(value - 1, 1);
    else if (event.key === "Home") nextValue = 1;
    else if (event.key === "End") nextValue = 5;
    else return;
    event.preventDefault();
    ratingButtons.current[nextValue - 1]?.focus();
  }

  function selectRating(value) {
    setHoveredRating(null);
    setFocusedRating(null);
    onRating(value);
  }

  const isOwner = recipe.ownerId === userId;

  return (
    <section className="recipe-detail" aria-labelledby="detail-title">
      <button className="text-button back-link" onClick={onBack} type="button">← Back to recipes</button>
      <div className="detail-header">
        <div>
          <p className="eyebrow">{recipe.category || "From the community"}</p>
          <h1 id="detail-title">{recipe.title}</h1>
          <p>{recipe.description}</p>
        </div>
        {isOwner && (
          <div className="detail-actions">
            <button className="secondary-button" onClick={onEdit} type="button">Edit recipe</button>
            <button className="danger-button" disabled={deleteSubmitting} onClick={onDelete} type="button">
              {deleteSubmitting ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {recipe.images.length > 0 && (
        <div className="detail-images">
          {recipe.images.map((image, index) => <img alt={`${recipe.title} ${index + 1}`} key={image} src={image} />)}
        </div>
      )}

      <div className="detail-columns">
        <section>
          <h2>Ingredients</h2>
          <ul className="ingredient-list">{recipe.ingredients.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </section>
        <section>
          <h2>Method</h2>
          <ol className="method-list">{recipe.steps.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol>
        </section>
      </div>

      <section className="community-panel">
        <div className="rating-heading">
          <div>
            <h2>Rate this recipe</h2>
            <p>
              {ratingSummary.averageRating === null
                ? "No ratings yet"
                : `${Number(ratingSummary.averageRating).toFixed(1)} out of 5 · ${ratingSummary.ratingCount} ${ratingSummary.ratingCount === 1 ? "rating" : "ratings"}`}
            </p>
          </div>
          <div
            aria-label="Your rating"
            className="star-picker"
            onMouseLeave={() => setHoveredRating(null)}
            role="radiogroup"
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                aria-checked={viewerRating === value}
                aria-label={`Rate ${value} ${value === 1 ? "star" : "stars"}`}
                className={previewRating !== null
                  ? value <= previewRating ? "preview" : "unselected"
                  : value <= (viewerRating || 0) ? "selected" : "unselected"}
                disabled={ratingSubmitting}
                id={`recipe-rating-${recipe.id}-${value}`}
                key={value}
                onBlur={() => setFocusedRating(null)}
                onFocus={() => setFocusedRating(value)}
                onKeyDown={(event) => moveRatingFocus(event, value)}
                onMouseEnter={() => setHoveredRating(value)}
                onClick={() => selectRating(value)}
                ref={(button) => { ratingButtons.current[value - 1] = button; }}
                role="radio"
                tabIndex={viewerRating ? viewerRating === value ? 0 : -1 : value === 1 ? 0 : -1}
                type="button"
              >{value <= (previewRating ?? viewerRating ?? 0) ? "★" : "☆"}</button>
            ))}
          </div>
        </div>
        <p className="your-rating" aria-live="polite">
          {viewerRating ? `Your rating: ${viewerRating} out of 5` : "You haven’t rated this recipe yet."}
        </p>

        <h2>Kitchen notes</h2>
        {detailLoading ? <p role="status">Loading comments…</p> : comments.length === 0 ? <p>No comments yet. Leave the first kitchen note.</p> : (
          <ul className="comment-list">
            {comments.map((comment) => (
              <li key={comment.id}>
                <p>{comment.text}</p>
                <small>Home cook #{comment.userId} · {comment.createdAt}</small>
              </li>
            ))}
          </ul>
        )}
        <form className="comment-form" onSubmit={onSubmitComment}>
          <label htmlFor="comment-text">Add a comment</label>
          <textarea
            id="comment-text"
            maxLength={2000}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="How did it turn out?"
            required
            rows={3}
            value={commentText}
          />
          <button className="secondary-button" disabled={commentSubmitting} type="submit">
            {commentSubmitting ? "Posting…" : "Post comment"}
          </button>
        </form>
        {detailError && <p className="notice error" role="alert">{detailError}</p>}
      </section>
    </section>
  );
}

export { requestJson };
