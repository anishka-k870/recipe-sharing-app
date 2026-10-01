import { useEffect, useState } from "react";
import RecipeApp from "./recipe-app.jsx";

export default function RegistrationForm() {
  const [mode, setMode] = useState("register");
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionNotice, setSessionNotice] = useState("");
  const [form, setForm] = useState({ email: "", password: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (response.ok && active) setUser(result.user);
      })
      .catch(() => {
        if (active) setSessionNotice("Unable to check your saved session. You can still sign in below.");
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => { active = false; };
  }, []);

  if (user) {
    return (
      <RecipeApp
        onLogout={async () => {
          try {
            const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
            if (!response.ok) setSessionNotice("Your local session ended, but the sign-out request did not reach the server.");
          } catch {
            setSessionNotice("Your local session ended, but the sign-out request did not reach the server.");
          } finally {
            setUser(null);
          }
        }}
        onUnauthorized={() => {
          setUser(null);
          setSessionNotice("Your session expired. Sign in again to continue.");
        }}
        user={user}
      />
    );
  }

  if (checkingSession) {
    return <main className="session-loading" role="status">Checking your kitchen session…</main>;
  }

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setError(false);
    setSubmitting(true);

    try {
      const action = mode === "register" ? "register" : "session";
      const response = await fetch(`/api/auth/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(form),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(true);
        setMessage(result.error || "We couldn't complete your request. Please try again.");
        return;
      }
      if (mode === "login") {
        setUser(result.user);
        return;
      }

      setForm((current) => ({ ...current, password: "" }));
      setMode("login");
      setMessage("Your account is ready. Sign in to start sharing recipes.");
    } catch {
      setError(true);
      setMessage("Unable to reach the server. Please try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleMode() {
    setMessage("");
    setError(false);
    setMode((current) => current === "register" ? "login" : "register");
  }

  return (
    <main className="page">
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">A little inspiration, served daily</p>
        <h1 id="page-title">Good food is better when it’s shared.</h1>
        <p className="intro-copy">
          Save the recipes you love and discover what everyone else is cooking.
        </p>
        <div className="recipe-note" aria-hidden="true">
          <span className="note-mark">✳</span>
          <p>Made with care.<br />Passed around with love.</p>
        </div>
      </section>

      <section className="form-panel" aria-labelledby="form-title">
        <div className="form-heading">
          <span className="wordmark">the recipe table</span>
          <p className="eyebrow">{mode === "register" ? "Your seat is waiting" : "Welcome back"}</p>
          <h2 id="form-title">{mode === "register" ? "Create your account" : "Sign in to your kitchen"}</h2>
          <p className="form-copy">
            {mode === "register" ? "Join our community of home cooks." : "Pick up where your next great meal begins."}
          </p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <input
            autoComplete="email"
            id="email"
            name="email"
            onChange={updateField}
            placeholder="you@example.com"
            required
            type="email"
            value={form.email}
          />

          <label htmlFor="password">Password</label>
          <input
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            id="password"
            minLength={mode === "register" ? 8 : undefined}
            name="password"
            onChange={updateField}
            placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
            required
            type="password"
            value={form.password}
          />
          {mode === "register" && <p className="hint">Use at least 8 characters.</p>}

          <button disabled={submitting} type="submit">
            {submitting
              ? mode === "register" ? "Setting your place…" : "Signing you in…"
              : mode === "register" ? "Create account" : "Sign in"}
            {!submitting && <span aria-hidden="true">→</span>}
          </button>
          <p aria-live="polite" className={`message${error ? " error" : ""}`} role={error ? "alert" : "status"}>
            {message || sessionNotice}
          </p>
        </form>
        <p className="auth-switch">
          {mode === "register" ? "Already have a place here?" : "New to the table?"}
          <button className="text-button" onClick={toggleMode} type="button">
            {mode === "register" ? "Sign in" : "Create an account"}
          </button>
        </p>
        <p className="terms">By joining, you agree to bring something delicious to the table.</p>
      </section>
    </main>
  );
}
