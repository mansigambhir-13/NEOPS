import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import NeopConsole from "./NeopConsole.jsx";
import QuickBuild from "./QuickBuild.jsx";

/* hash router: #build → the Quick Build workshop; anything else → the console.
   Two rooms, one binary: the night shift watches NEOPs run, the daylight
   workshop composes them. */
function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash === "#build" ? <QuickBuild /> : <NeopConsole />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
