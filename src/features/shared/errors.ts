export function friendlyError(message: string) {
  if (message.includes("Linear auth failed") || message.includes("Linear HTTP error 401")) {
    return "Linear rejected the request. Update the API key in Settings → Linear.";
  }
  if (message.includes("front matter") || message.includes("tracker configuration")) {
    return `Workflow needs attention: ${message}. Edit it in Settings → Workflow.`;
  }
  return message;
}

export function formatError(err: unknown) {
  const message = String(err);
  if (message.includes("invoke") || message.includes("transformCallback")) {
    return "Unable to reach the desktop runtime. Open the Tauri app for live actions.";
  }
  return friendlyError(message);
}

export function normalizeBootstrapError(err: unknown) {
  const message = formatError(err)
    .replace(/^Error:\s*/i, "")
    .trim();
  return message || "The desktop runtime did not return startup data.";
}
