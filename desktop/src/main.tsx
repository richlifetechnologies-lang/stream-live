import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { purgeLegacyKeys } from "./lib/credentials";
import { syncClockWithServer } from "./lib/gateway";

purgeLegacyKeys();
// Before anything on this window reads a clock: the machine's own time is the one thing
// that can throw away a call pass, and it is not the customer's job to fix it.
void syncClockWithServer();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
