import React from "react";
import { createRoot } from "react-dom/client";
import NeopConsole from "./NeopConsole.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <NeopConsole />
  </React.StrictMode>,
);
