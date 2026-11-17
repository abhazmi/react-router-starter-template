import "../app/app.css";
import { createRoot } from "react-dom/client";
import Home from "../app/routes/home";
createRoot(document.getElementById("root")!).render(<Home {...({} as any)} />);
