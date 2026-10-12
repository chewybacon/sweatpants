/** This index is a browser convenience; conversation state lives on the server. */
export function readThreadIds(): string[] {
  const current = localStorage.getItem("yo-tisyn.thread");
  let saved: unknown = [];
  try {
    saved = JSON.parse(localStorage.getItem("yo-tisyn.threads") ?? "[]");
  } catch (error) {
    console.warn("[yo-tisyn] Could not read the browser thread index", error);
  }
  const ids = Array.isArray(saved) ? saved : [];
  return [
    ...new Set(
      [current, ...ids].filter(
        (id): id is string => typeof id === "string" && /^[a-f0-9-]{16,64}$/i.test(id),
      ),
    ),
  ];
}

export function rememberThread(id: string) {
  const recent = readThreadIds();
  localStorage.setItem("yo-tisyn.thread", id);
  localStorage.setItem(
    "yo-tisyn.threads",
    JSON.stringify([id, ...recent.filter((threadId) => threadId !== id)].slice(0, 12)),
  );
}
