import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioApp } from "./App";
import { StudioErrorBoundary } from "./components/StudioErrorBoundary";
import { trackStudioEvent } from "./utils/studioTelemetry";
import "./styles/studio.css";

trackStudioEvent("session_start");

function errorProps(value: unknown): {
  error_message: string;
  error_name: string | null;
  stack_trace: string | null;
} {
  if (value instanceof Error) {
    return {
      error_message: value.message,
      error_name: value.name,
      stack_trace: value.stack?.slice(0, 4000) ?? null,
    };
  }
  return { error_message: String(value), error_name: null, stack_trace: null };
}

function isCompositionAssetError(msg: string): boolean {
  return msg.includes("Error fetching") && (msg.includes("404") || msg.includes("Not Found"));
}

const ERROR_CAP = 50;
let errorCount = 0;
let rejectionCount = 0;
let errorCapSent = false;
let rejectionCapSent = false;

window.addEventListener("error", (event) => {
  if (event.message?.includes("ResizeObserver loop")) {
    event.stopImmediatePropagation();
    event.preventDefault();
    return;
  }

  errorCount++;
  if (errorCount > ERROR_CAP) {
    if (!errorCapSent) {
      errorCapSent = true;
      trackStudioEvent("error_cap_reached", { count: errorCount });
    }
    return;
  }

  trackStudioEvent("unhandled_error", {
    ...errorProps(event.error),
    error_message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const props = errorProps(event.reason);
  if (isCompositionAssetError(props.error_message)) return;

  rejectionCount++;
  if (rejectionCount > ERROR_CAP) {
    if (!rejectionCapSent) {
      rejectionCapSent = true;
      trackStudioEvent("rejection_cap_reached", { count: rejectionCount });
    }
    return;
  }

  trackStudioEvent("unhandled_promise_rejection", props);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioErrorBoundary>
      <StudioApp />
    </StudioErrorBoundary>
  </StrictMode>,
);
