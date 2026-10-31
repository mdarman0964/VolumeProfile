import React from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "../src/components/desk/terminal";
import "../src/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Android app root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <Terminal />
  </React.StrictMode>,
);
