import { createRoot } from "react-dom/client";
import "./index.css";
import PortraitLabPage from "./pages/portrait-lab";

// Dev-only entry (lab.html). Not listed as a vite build input, so a packaged
// build never contains it. StrictMode is left off deliberately: its double mount
// would open the webcam twice for no reason.
createRoot(document.getElementById("root")!).render(<PortraitLabPage />);
