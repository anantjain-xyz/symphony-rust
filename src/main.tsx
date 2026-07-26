import { lazy, StrictMode, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const AppUpdateGeometryPreview = lazy(() =>
  import("./AppUpdate").then((module) => ({
    default: module.AppUpdateGeometryPreview,
  })),
);
const updaterGeometryPreview = window.location.search === "?preview=updater";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {updaterGeometryPreview ? (
      <Suspense fallback={null}>
        <AppUpdateGeometryPreview />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
