import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./base.css";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
