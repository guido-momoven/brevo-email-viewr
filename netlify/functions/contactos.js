/**
 * Momoven · Visor de mails · Función «contactos»
 * ----------------------------------------------
 * Busca en Brevo contactos de ejemplo que cumplan las condiciones del mail que se está viendo.
 *
 * Variables de entorno (Netlify → Site configuration → Environment variables, marcadas como secretas):
 *   BREVO_API_KEY         Clave de la API de Brevo (mejor una propia para esta herramienta).
 *   MASTER_PASSWORD       Contraseña de equipo. Solo la tenéis Nico y Guido.
 *   ATRIBUTOS_PERMITIDOS  (opcional) Lista separada por comas. Sustituye a la de abajo.
 *
 * Qué hace y qué no:
 *   - Solo responde a POST con la contraseña correcta.
 *   - Solo consulta atributos de la lista PERMITIDOS (nunca NOMBRE, teléfono ni nada personal más allá del email).
 *   - Devuelve como máximo 3 contactos, sin los dados de baja de email.
 *   - No guarda nada. Los registros solo dicen qué atributos se consultaron y cuántos contactos salieron.
 */
const crypto = require('crypto');

const BREVO = 'https://api.brevo.com/v3';
const PERMITIDOS = [
  'LANGUAGE', 'TIPO_USUARIO', 'LIFECYCLE_STAGE',
  'HOST_HAS_IB', 'HOST_HAS_RTB', 'CURRENT_BOOKING_STATUS', 'CURRENT_BOOKING_START', 'CURRENT_BOOKING_END',
  'SEARCH_STATUS', 'SEARCH_STEP', 'SEARCH_STRATEGY', 'SEARCH_AUDIENCE', 'SEARCH_CITY', 'SEARCH_DAYS_TO_TRIP',
  'SEARCH_IS_NEW', 'SEARCH_VARIANT',
];
const PAGINAS_MAX = 2;          // 2 páginas de 1.000 contactos como máximo
const MAX_RESULTADOS = 3;
const FALLOS_MAX = 5;           // intentos de contraseña fallidos...
const VENTANA_MS = 10 * 60e3;   // ...en 10 minutos, por IP (mejor esfuerzo: la memoria de la función se reinicia)
const fallos = new Map();

const json = (status, cuerpo) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(cuerpo),
});
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();

function permitidos() {
  const env = (process.env.ATRIBUTOS_PERMITIDOS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return env.length ? env : PERMITIDOS;
}

function contrasenaCorrecta(dada) {
  const real = process.env.MASTER_PASSWORD || '';
  if (!real) return false;
  return crypto.timingSafeEqual(hash(dada || ''), hash(real));
}

function ipDe(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
}

function bloqueada(ip, ahora) {
  const f = (fallos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  fallos.set(ip, f);
  return f.length >= FALLOS_MAX;
}

/** equals(ATRIBUTO,"valor"): texto entre comillas; true/false y números, sin ellas (probamos las dos formas). */
function literal(valor, entreComillas) {
  const v = String(valor);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  if (!entreComillas && /^-?\d+(\.\d+)?$/.test(v)) return v;
  return '"' + v.replace(/"/g, '') + '"';
}

async function brevoGet(ruta, clave) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(BREVO + ruta, { headers: { 'api-key': clave, accept: 'application/json' }, signal: ctrl.signal });
    const texto = await r.text();
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; }
    return { status: r.status, cuerpo };
  } finally {
    clearTimeout(t);
  }
}

/** Una página de contactos. Si Brevo rechaza el filtro (400) se prueba con otra forma y, al final, sin filtro. */
async function pagina(clave, { segmentId, principal, offset }) {
  const base = '/contacts?limit=1000&sort=desc&offset=' + offset + (segmentId ? '&segmentId=' + segmentId : '');
  if (!principal) return { r: await brevoGet(base, clave), filtrado: false };
  for (const comillas of [false, true]) {
    const f = 'equals(' + principal.attr + ',' + literal(principal.valor, comillas) + ')';
    const r = await brevoGet(base + '&filter=' + encodeURIComponent(f), clave);
    if (r.status !== 400) return { r, filtrado: true };
  }
  return { r: await brevoGet(base, clave), filtrado: false };
}

function coincide(contacto, f) {
  const a = (contacto.attributes || {})[f.attr];
  const v = String(f.valor).toLowerCase();
  if (Array.isArray(a)) return a.some((x) => String(x).toLowerCase() === v);
  if (typeof a === 'boolean') return String(a) === v;
  return a !== undefined && a !== null && String(a).toLowerCase() === v;
}

// Valores de LANGUAGE que las plantillas tratan como inglés; todo lo demás (incluido vacío) cae en la rama en español.
const INGLES = ['en', 'en-gb', 'en-us', 'en_gb', 'en_us', 'english'];
function esIngles(c) {
  return INGLES.indexOf(String((c.attributes || {}).LANGUAGE || '').trim().toLowerCase()) !== -1;
}
function coincideIdioma(c, idioma) {
  return idioma === 'en' ? esIngles(c) : !esIngles(c);
}

function validar(cuerpo) {
  const lista = permitidos();
  const filtros = Array.isArray(cuerpo.filtros) ? cuerpo.filtros : [];
  if (filtros.length > 4) return { error: 'Demasiados filtros (máximo 4).' };
  const limpios = [];
  const noPermitidos = [];
  for (const f of filtros) {
    const attr = String((f && f.attr) || '').toUpperCase();
    const valor = f && f.valor !== undefined && f.valor !== null ? String(f.valor) : '';
    if (!/^[A-Z0-9_]{2,40}$/.test(attr)) return { error: 'Atributo no válido.' };
    if (!/^[\p{L}\p{N} _.:@+\-]{1,60}$/u.test(valor)) return { error: 'Valor no válido para ' + attr + '.' };
    if (lista.indexOf(attr) === -1) { noPermitidos.push(attr); continue; }
    limpios.push({ attr, valor });
  }
  if (noPermitidos.length) return { error: 'Atributos no permitidos: ' + noPermitidos.join(', ') + '.', noPermitidos };
  const segmentId = cuerpo.segmentId ? Number(cuerpo.segmentId) : 0;
  if (cuerpo.segmentId && !(Number.isInteger(segmentId) && segmentId > 0 && segmentId < 1e7)) return { error: 'Segmento no válido.' };
  const idioma = cuerpo.idioma === undefined || cuerpo.idioma === null || cuerpo.idioma === '' ? '' : String(cuerpo.idioma).toLowerCase();
  if (idioma && idioma !== 'es' && idioma !== 'en') return { error: 'Idioma no válido.' };
  if (!limpios.length && !segmentId && !idioma) return { error: 'Indica al menos un filtro, un idioma o un segmento.' };
  const max = Math.min(Math.max(parseInt(cuerpo.max, 10) || MAX_RESULTADOS, 1), MAX_RESULTADOS);
  return { filtros: limpios, segmentId, idioma, max };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });
  if (!process.env.BREVO_API_KEY || !process.env.MASTER_PASSWORD) {
    return json(500, { error: 'La función no está configurada (faltan variables de entorno).' });
  }
  let cuerpo;
  try {
    if ((event.body || '').length > 5000) throw new Error('grande');
    cuerpo = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Petición no válida.' });
  }

  const ip = ipDe(event);
  const ahora = Date.now();
  if (bloqueada(ip, ahora)) return json(429, { error: 'Demasiados intentos. Espera unos minutos.' });
  if (!contrasenaCorrecta(cuerpo.password)) {
    fallos.get(ip).push(ahora);
    await espera(process.env.ESPERA_FALLO_MS ? Number(process.env.ESPERA_FALLO_MS) : 900);
    return json(401, { error: 'Contraseña incorrecta.' });
  }

  const v = validar(cuerpo);
  if (v.error) return json(400, { error: v.error, noPermitidos: v.noPermitidos || [] });

  try {
    const principal = v.filtros[0];
    let revisados = 0, truncado = false;
    const encontrados = [];
    for (let p = 0; p < PAGINAS_MAX; p++) {
      const { r } = await pagina(process.env.BREVO_API_KEY, { segmentId: v.segmentId, principal, offset: p * 1000 });
      if (r.status !== 200 || !r.cuerpo) {
        console.log(JSON.stringify({ evento: 'brevo_error', status: r.status }));
        return json(502, { error: 'Brevo no ha respondido bien (' + r.status + ').' });
      }
      const contactos = r.cuerpo.contacts || [];
      revisados += contactos.length;
      // Se comprueban todos los filtros aquí, aunque Brevo ya haya filtrado: no dependemos de cómo combine filtro y segmento.
      contactos.forEach((c) => {
        if (c.emailBlacklisted) return;
        if (v.idioma && !coincideIdioma(c, v.idioma)) return;
        if (v.filtros.every((x) => coincide(c, x))) encontrados.push(c);
      });
      if (contactos.length < 1000) break;
      if (p === PAGINAS_MAX - 1) truncado = true;
      if (encontrados.length >= v.max * 20) break;
    }
    const lista = permitidos();
    const salida = encontrados.slice(0, v.max).map((c) => ({
      id: c.id,
      email: c.email,
      atributos: Object.keys(c.attributes || {}).filter((k) => lista.indexOf(k) !== -1).reduce((o, k) => { o[k] = c.attributes[k]; return o; }, {}),
    }));
    console.log(JSON.stringify({ evento: 'consulta', atributos: v.filtros.map((f) => f.attr), segmento: v.segmentId || null, idioma: v.idioma || null, revisados, coincidencias: encontrados.length, devueltos: salida.length }));
    return json(200, { ok: true, contactos: salida, revisados, coincidencias: encontrados.length, truncado });
  } catch (e) {
    console.log(JSON.stringify({ evento: 'error', mensaje: String(e && e.message) }));
    return json(502, { error: 'No he podido consultar Brevo.' });
  }
};

exports._fallos = fallos; // solo para las pruebas
