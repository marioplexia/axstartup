/* Harness de agentes (copia del canónico): llamadas a la IA con reintentos. */

export const MODEL = "claude-sonnet-5-5";
export const NIL_USER = "00000000-0000-0000-0000-000000000000";
export const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const transitorio = (s: number) => s === 0 || s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

export async function llamarIA(payload: Record<string, unknown>, o: { intentos?: number; timeoutMs?: number; presupuestoMs?: number } = {}) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { error: "ai_not_configured", intentos: 0 } as const;
  const max = o.intentos ?? 3;
  const t0 = Date.now();
  let status = 0;
  let detalle = "";
  for (let i = 1; i <= max; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 45000);
    let espera = Math.min(8000, 700 * 2 ** (i - 1));
    status = 0;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, ...payload }),
      });
      if (r.ok) return { data: await r.json(), intentos: i } as const;
      status = r.status;
      const t = await r.text().catch(() => "");
      console.error("anthropic", status, "intento", i, t.slice(0, 300));
      detalle = clip(t, 300);
      try { const j = JSON.parse(t); detalle = clip((j.error && j.error.message) || t, 300); } catch { /* texto plano */ }
      const ra = Number(r.headers.get("retry-after"));
      if (status === 429 && ra > 0) espera = Math.min(8000, ra * 1000);
    } catch (e) {
      detalle = "";
      console.error("anthropic fetch", "intento", i, String(e));
    } finally {
      clearTimeout(to);
    }
    if (!transitorio(status) || i === max || Date.now() - t0 > (o.presupuestoMs ?? 100000)) return { error: "upstream", status, intentos: i, detalle } as const;
    await sleep(espera + Math.random() * 300);
  }
  return { error: "upstream", status, intentos: max, detalle } as const;
}

export async function llamarHerramienta(payload: Record<string, any>, nombre: string, o = {}) {
  const p = { ...payload };
  delete p.tool_choice;
  let r: any = await llamarIA(p, o);
  let intentos = r.intentos || 0;
  if (!r.error && !(r.data.content || []).some((b: any) => b.type === "tool_use" && b.name === nombre)) {
    const prev = (r.data.content || []).filter((b: any) => b.type === "text" && b.text);
    const messages = [
      ...p.messages,
      { role: "assistant", content: prev.length ? prev : [{ type: "text", text: "Voy a registrar el resultado." }] },
      { role: "user", content: "Entrega el resultado llamando ahora a la herramienta \"" + nombre + "\", sin texto adicional." },
    ];
    r = await llamarIA({ ...p, messages }, o);
    intentos += r.intentos || 0;
  }
  return { ...r, intentos };
}
