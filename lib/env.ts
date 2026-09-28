export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
