/** Shown instantly while a page runs its queries on the server. */
export default function Loading() {
  return (
    <main>
      <p className="muted" aria-busy="true">Loading…</p>
    </main>
  );
}
