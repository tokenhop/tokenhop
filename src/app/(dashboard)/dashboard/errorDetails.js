/** Only copy a server digest or fixed support text; never raw error messages. */
export function getCopyableErrorDetails(error) {
  const digest = error?.digest;
  return typeof digest === "string" && digest
    ? digest
    : "Dashboard render error (no digest available)";
}
