import React from "react";
import { createRoot } from "react-dom/client";
import RegistrationForm from "./registration-form.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RegistrationForm />
  </React.StrictMode>,
);
