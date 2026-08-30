import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { installGlobalDiagnostics } from "@/lib/diagnostics";
import { installStaleChunkRecovery } from "@/lib/stale-chunk";
import "./index.css";

installGlobalDiagnostics();
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(<App />);
