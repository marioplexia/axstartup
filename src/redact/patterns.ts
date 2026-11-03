/**
 * Patrones de datos personales para México. Mejor esfuerzo: ante la duda se sobre-redacta.
 * Cada regla devuelve una etiqueta ([TEL], [RFC]…); `vin` se trata aparte (ver vin.ts).
 */
export type Label = 'EMAIL' | 'CURP' | 'RFC' | 'CLAVE_ELECTOR' | 'TEL' | 'CP' | 'DOMICILIO' | 'PLACA' | 'NOMBRE' | 'VIN';
export interface Rule { label: Label; re: RegExp; /** devuelve true si el hallazgo es un falso positivo y debe dejarse tal cual */ skip?: (m: string, groups: string[]) => boolean; replace?: (m: string, ...groups: string[]) => string }

/** Primera letra en ambos casos y versión en mayúsculas: "calle" -> (?:[Cc]alle|CALLE) */
const kw = (...words: string[]) => '(?:' + words.map(w => {
  const esc = w.replace(/\./g, '\\.');
  return `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${esc.slice(1)}|${esc.toUpperCase()}`;
}).join('|') + ')';

// ───────── nombres propios (tras disparadores) ─────────
const TRIG_NAME = kw('cliente', 'clienta', 'propietario', 'propietaria', 'titular', 'conductor', 'conductora', 'contacto',
  'srita.', 'srita', 'sra.', 'sr.', 'señor', 'señora', 'don', 'doña', 'lic.', 'ing.', 'dr.', 'dra.', 'arq.', 'mtro.', 'mtra.',
  'a nombre de', 'nombre', 'asesor', 'asesora', 'técnico', 'tecnico', 'técnica', 'gerente', 'ejecutivo', 'ejecutiva',
  'hablé con', 'hable con', 'habló con', 'hablo con', 'llamé a', 'atendió', 'atendio', 'atte.', 'att.', 'atentamente',
  'saludos', 'gracias', 'cordialmente', 'quedo atento', 'quedo atenta');
const CAP = String.raw`[A-ZÁÉÍÓÚÑ][\p{L}']+`;
export const NAME_RE = new RegExp(`(${TRIG_NAME}[,]?\\s*:?\\s+)(${CAP}(?:\\s+(?:(?:de|del|la|los|las)\\s+)?${CAP}){0,3})`, 'gu');

// ───────── domicilio ─────────
const STOP = ['Col', 'Colonia', 'Fracc', 'Fraccionamiento', 'Cliente', 'Clienta', 'Tel', 'Cel', 'CP', 'C\\.P', 'Código', 'Municipio', 'Mpio', 'Estado', 'Edo', 'Ciudad', 'Entre', 'Esq', 'Esquina', 'Núm', 'Num', 'No', 'Int', 'Interior', 'Depto', 'Dpto', 'Lote', 'Mz', 'Manzana']
  .flatMap(w => [w, w.toUpperCase()]).join('|');
const NAMEWORD = String.raw`(?:(?!(?:${STOP})\b)[A-ZÁÉÍÓÚÑ0-9][\p{L}\d'.-]*|de|del|la|las|los|y)`;
const NUMBER = String.raw`(?:\s*,?\s*(?:#|[Nn]o\.?|[Nn]úm\.?|[Nn]um\.?|[Nn]úmero|[Nn]°|NO\.?|NUM\.?)\s*\d+[A-Za-z]?(?![\p{L}])(?:[-/]\d+)?)?`;
const INTERIOR = String.raw`(?:\s*,?\s*(?:[Ii]nt\.?|[Ii]nterior|[Dd]epto\.?|[Dd]pto\.?|[Ll]ote|[Mm]z\.?|[Mm]anzana)\s*\w+)*`;
const STREET_KW = kw('calle', 'c.', 'av.', 'avenida', 'blvd.', 'boulevard', 'bulevar', 'calzada', 'calz.', 'privada', 'priv.', 'andador', 'circuito', 'cerrada', 'cda.', 'carretera', 'camino', 'prolongación', 'prol.', 'periférico', 'retorno', 'paseo', 'callejón', 'diagonal', 'eje');
const COLONIA_KW = kw('colonia', 'col.', 'fracc.', 'fraccionamiento', 'barrio', 'residencial', 'unidad habitacional', 'u.h.');
export const STREET_RE = new RegExp(`\\b${STREET_KW}\\s*${NAMEWORD}(?:[ \\t]+${NAMEWORD}){0,3}${NUMBER}${INTERIOR}`, 'gu');
export const COLONIA_RE = new RegExp(`\\b${COLONIA_KW}\\s*${NAMEWORD}(?:[ \\t]+${NAMEWORD}){0,3}`, 'gu');
export const CP_RE = /\b(?:[Cc]\.?\s?[Pp]\.?|[Cc]ódigo [Pp]ostal|[Cc]od\.? [Pp]ostal)\s*:?\s*\d{5}\b/g;

// ───────── teléfonos ─────────
const TEL_PREFIX = String.raw`(?:(?:\+|00)?52[\s.-]?(?:1[\s.-]?)?|0(?:44|45|1)[\s.-]?)?`;
const TEL_CORE = String.raw`(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{3,4}[\s.-]?\d{4}`;
export const TEL_RE = new RegExp(String.raw`(?<![\w$-])(?<!\d[.,])${TEL_PREFIX}${TEL_CORE}(?![\w-]|[.,]\d)`, 'g');
/** 7-8 dígitos sin lada: solo con una palabra de contexto delante ("tel 123 4567", "cel: 1234-5678"). */
const TEL_CTX = '(?:tel(?:[eé]fono)?s?|cel(?:ular)?|m[oó]vil|whats\\s?app|whats|fijo|llamar al?|marcar al|al tel)';
export const TEL_LOCAL_RE = new RegExp(String.raw`(\b${TEL_CTX}\.?[\s:.#]*)(\d{3,4}[\s.-]?\d{4})(?![\w-]|[.,]\d)`, 'giu');

// ───────── identificadores ─────────
export const EMAIL_RE = /[A-Za-z0-9._%+-]+\s?(?:@|\(at\)|\[at\])\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_WORDS_RE = /\b[\w.+-]+\s+arroba\s+[\w-]+(?:\s+punto\s+[\w-]+)+\b/gi;
const SEP = String.raw`[\s-]?`;
export const CURP_RE = new RegExp(String.raw`(?<![\w])[A-Z]{4}${SEP}\d{6}${SEP}[HM]${SEP}[A-Z]{5}${SEP}[A-Z0-9]\d(?![\w])`, 'gi');
export const RFC_RE = new RegExp(String.raw`(?<![\w])[A-ZÑ&]{3,4}${SEP}\d{6}${SEP}[A-Z0-9]{3}(?![\w])`, 'gi');
/** Clave de elector: 6 letras + 6 dígitos (fecha) + 2 (entidad) + sexo + 3 dígitos. */
export const ELECTOR_RE = /(?<![\w])[A-Z]{6}\d{8}[HM]\d{3}(?![\w])/gi;
/** CIC/OCR de la credencial, solo con la palabra clave delante. */
export const ELECTOR_CTX_RE = new RegExp(String.raw`(${kw('clave de elector', 'clave elector', 'INE', 'IFE', 'credencial para votar', 'credencial', 'CIC', 'OCR')}[\s:#.]*)([A-Z0-9]{9,18})(?![\w])`, 'gu');

// ───────── placas ─────────
const PLATE_PREFIX_SKIP = new Set(['DTC', 'VIN', 'TSB', 'ODT', 'REF', 'PRE', 'OPE', 'KIT', 'PZA', 'FOL', 'NUM']);
export const PLACA_RE = /(?<![\w-])(?:[A-Z]{3}-\d{2,4}(?:-[A-Z0-9]{1,2})?|[A-Z]{3}-\d{3}-[A-Z]|\d{3}-[A-Z]{3}|[A-Z]\d{2}-[A-Z]{3}|[A-Z]{3}\s\d{3}\s?[A-Z]|[A-Z]{2}-\d{2}-\d{3})(?![\w-])/g;
export const PLACA_CTX_RE = /(\b[Pp]lacas?\b[\s:.#]*(?:de\s+)?)([A-Z0-9]{2,4}[\s-]?[A-Z0-9]{2,4}(?:[\s-][A-Z0-9]{1,2})?)(?![\w-])/gi;
export const plateSkip = (m: string) => PLATE_PREFIX_SKIP.has(m.slice(0, 3));

// ───────── llaves de campos de cliente ─────────
export type FieldKind = 'NOMBRE' | 'TEL' | 'EMAIL' | 'DOMICILIO' | 'PLACA' | 'RFC' | 'CURP' | 'CP';
const K = (s: string) => new RegExp(s, 'i');
export const FIELD_KEYS: Array<[FieldKind, RegExp]> = [
  ['EMAIL', K('(correo|e-?mail)')],
  ['TEL', K('(tel[eé]fono|telefono|phone|^tel|_tel$|celular|^cel|m[oó]vil|whats)')],
  ['RFC', K('^rfc|_rfc')],
  ['CURP', K('curp')],
  ['CP', K('(c[oó]digo_?postal|^cp$|_cp$|zip)')],
  ['DOMICILIO', K('(domicilio|direcci[oó]n|address|calle|colonia|^col$)')],
  ['PLACA', K('(placa|matr[ií]cula)')],
  ['NOMBRE', K('^(nombre|name)$|^(customer|cliente|owner|propietari[oa]|titular|conductor[a]?|contacto)(_|$)|(_|^)(customer|cliente|propietari[oa]|titular|conductor|contacto)_?(name|nombre)?$|nombre_?(cliente|propietari[oa]|titular|conductor)')],
];
export function fieldKind(key: string): FieldKind | null {
  for (const [kind, re] of FIELD_KEYS) if (re.test(key)) return kind;
  return null;
}
