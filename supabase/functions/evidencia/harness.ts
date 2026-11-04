/* ══ Harness de agentes · paso 1: ejecuciones, reintentos y reanudación ═════════
   Lo comparten las funciones `documento` y `evidencia` (cada una lleva su copia en su paquete).

   · llamarIA / llamarHerramienta: llamadas a la IA con REINTENTOS solo para fallas transitorias
     (red, tiempo agotado, 429, 5xx) y espera creciente. Un 4xx de verdad no se reintenta.
   · Run: cada corrida queda en `agent_runs` con sus pasos. Lo ya hecho se guarda en `checkpoint`,
     así que reintentar con el mismo run_id REANUDA donde falló en lugar de empezar de cero
     (y sin volver a pagar la lectura de la IA si ya salió bien).
   · La bitácora nunca rompe al agente: si no se puede escribir, la corrida sigue sin ella. */

export const MODEL = "claude-sonnet-5-5";
export const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* red, tiempo agotado (0), petición lenta, límite de uso y fallas del servidor (incluye 529, sobrecargado) */
const transitorio = (s: number) => s === 0 || s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

export async function llamarIA(payload: Record<string, unknown>, o: { intentos?: number; timeoutMs?: number; presupuestoMs?: number } = {}) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { error: "ai_not_configured", intentos: 0 } as const;
  const max = o.intentos ?? 3;
  const t0 = Date.now();
  let status = 0;
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
      const ra = Number(r.headers.get("retry-after"));
      if (status === 429 && ra > 0) espera = Math.min(8000, ra * 1000);
    } catch (e) {
      console.error("anthropic fetch", "intento", i, String(e));
    } finally {
      clearTimeout(to);
    }
    /* sin más intentos, sin presupuesto de tiempo o un error que no se arregla reintentando */
    if (!transitorio(status) || i === max || Date.now() - t0 > (o.presupuestoMs ?? 100000)) return { error: "upstream", status, intentos: i } as const;
    await sleep(espera + Math.random() * 300);
  }
  return { error: "upstream", status, intentos: max } as const;
}

/* este modelo no admite tool_choice forzado: la herramienta va en modo automático y, si el modelo
   contesta con texto, se le pide una vez más que la use */
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

export type Paso<T> = { ok: boolean; valor?: T; error?: string; omitido?: boolean };

export class Run {
  id: string | null = null;
  reanudada = false;
  steps: any[] = [];
  checkpoint: any = {};
  intentos = 0;
  fallo: string[] = [];
  private t0 = Date.now();
  private sb: any;
  agent: string;
  private constructor(sb: any, agent: string) { this.sb = sb; this.agent = agent; }

  /* una corrida nueva, o la reanudación de una anterior (mismo usuario, mismo agente, sin terminar bien) */
  static async iniciar(sb: any, userId: string, agent: string, input: unknown, reanudar?: unknown) {
    const run = new Run(sb, agent);
    try {
      if (typeof reanudar === "string" && UUID_RE.test(reanudar)) {
        const r = await sb.from("agent_runs").select("id,status,steps,checkpoint,attempts").eq("id", reanudar).eq("agent", agent).maybeSingle();
        if (r.data && r.data.status !== "ok") {
          run.id = r.data.id;
          run.steps = Array.isArray(r.data.steps) ? r.data.steps : [];
          run.checkpoint = r.data.checkpoint && typeof r.data.checkpoint === "object" ? r.data.checkpoint : {};
          run.intentos = r.data.attempts || 0;
          run.reanudada = true;
          await sb.from("agent_runs").update({ status: "en_curso", error: null, finished_at: null, updated_at: new Date().toISOString() }).eq("id", run.id);
          return run;
        }
      }
      const ins = await sb.from("agent_runs").insert({ user_id: userId, agent, status: "en_curso", input }).select("id").single();
      if (ins.error) console.error("agent_runs insert", ins.error.message); else run.id = ins.data.id;
    } catch (e) {
      console.error("agent_runs", String(e));
    }
    return run;
  }

  hecho(n: string) { return !!(this.checkpoint.hecho && this.checkpoint.hecho[n]); }

  /* un paso con nombre: se salta si ya estaba hecho (reanudación), se reintenta si falla y queda en la bitácora.
     Con `clave`, su resultado se guarda en el checkpoint y una reanudación lo devuelve sin repetir el trabajo. */
  async paso<T>(nombre: string, fn: () => Promise<T>, o: { reintentos?: number; clave?: string } = {}): Promise<Paso<T>> {
    if (this.hecho(nombre) && (!o.clave || this.checkpoint[o.clave] !== undefined)) {
      return { ok: true, omitido: true, valor: o.clave ? this.checkpoint[o.clave] : undefined };
    }
    const t = Date.now();
    const reint = o.reintentos ?? 1;
    let err = "";
    for (let i = 0; i <= reint; i++) {
      try {
        const v = await fn();
        this.checkpoint.hecho = { ...(this.checkpoint.hecho || {}), [nombre]: true };
        if (o.clave) this.checkpoint[o.clave] = v;
        this.steps.push({ n: nombre, estado: "ok", ms: Date.now() - t, intento: i + 1 });
        this.fallo = this.fallo.filter((x) => x !== nombre);
        await this.guardar(nombre);
        return { ok: true, valor: v };
      } catch (e) {
        err = clip((e as Error)?.message ?? e, 300);
        if (i < reint) await sleep(300 * (i + 1));
      }
    }
    this.steps.push({ n: nombre, estado: "error", ms: Date.now() - t, error: err });
    if (!this.fallo.includes(nombre)) this.fallo.push(nombre);
    await this.guardar(nombre);
    return { ok: false, error: err };
  }

  private async guardar(paso: string) {
    if (!this.id) return;
    try {
      await this.sb.from("agent_runs").update({ step: paso, steps: this.steps.slice(-40), checkpoint: this.checkpoint, attempts: this.intentos, updated_at: new Date().toISOString() }).eq("id", this.id);
    } catch (e) {
      console.error("agent_runs update", String(e));
    }
  }

  /* al terminar bien se vacía el checkpoint (no se guarda de más); si falló se conserva para reanudar */
  async cerrar(ok: boolean, result: unknown, error?: string) {
    if (!this.id) return;
    try {
      await this.sb.from("agent_runs").update({
        status: ok ? "ok" : "error", result: result ?? null, error: ok ? null : clip(error, 300), steps: this.steps.slice(-40),
        checkpoint: ok ? {} : this.checkpoint, attempts: this.intentos, finished_at: new Date().toISOString(),
        duration_ms: Date.now() - this.t0, updated_at: new Date().toISOString(),
      }).eq("id", this.id);
    } catch (e) {
      console.error("agent_runs close", String(e));
    }
  }
}
