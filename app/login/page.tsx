export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main style={{ maxWidth: 360, paddingTop: 80 }}>
      <h1>Stock Screener</h1>
      <form method="post" action="/api/login" className="panel" style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="next" value={next ?? "/"} />
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" autoFocus required />
        </label>
        {error && <div className="down">Wrong password.</div>}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
