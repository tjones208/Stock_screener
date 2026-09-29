/** Shown instantly while the screener runs its query on the server. */
export default function Loading() {
  return (
    <main>
      <p className="muted" aria-busy="true">Loading screener…</p>
    </main>
  );
}
