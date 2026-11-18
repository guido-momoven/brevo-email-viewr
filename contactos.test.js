// Pruebas de la función «contactos» con Brevo simulado. Ejecutar:  node test/contactos.test.js
const assert = require('assert');
const mod = require('../netlify/functions/contactos.js');

process.env.BREVO_API_KEY = 'clave-de-prueba';
process.env.MASTER_PASSWORD = 'frase larga de prueba';
process.env.ESPERA_FALLO_MS = '0';

let llamadas = [];
let respuestas = [];
global.fetch = async (url, opts) => {
  llamadas.push({ url, headers: opts.headers });
  const r = respuestas.length ? respuestas.shift() : { status: 200, cuerpo: { contacts: [] } };
  return { status: r.status, text: async () => JSON.stringify(r.cuerpo) };
};
const logs = [];
const log0 = console.log;
console.log = (...a) => logs.push(a.join(' '));

const peticion = (cuerpo, extra = {}) => mod.handler({
  httpMethod: 'POST',
  headers: { 'x-nf-client-connection-ip': extra.ip || '1.1.1.1' },
  body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify({ password: 'frase larga de prueba', ...cuerpo }),
});
const c = (id, email, attributes, extra = {}) => ({ id, email, attributes, emailBlacklisted: false, ...extra });

const pruebas = [];
const t = (nombre, fn) => pruebas.push([nombre, fn]);
const reset = () => { llamadas = []; respuestas = []; mod._fallos.clear(); logs.length = 0; };

t('GET no está permitido (405)', async () => {
  const r = await mod.handler({ httpMethod: 'GET', headers: {} });
  assert.strictEqual(r.statusCode, 405);
});
t('sin variables de entorno → 500 sin detalles', async () => {
  const guardada = process.env.MASTER_PASSWORD; delete process.env.MASTER_PASSWORD;
  const r = await peticion({ filtros: [] });
  process.env.MASTER_PASSWORD = guardada;
  assert.strictEqual(r.statusCode, 500);
  assert.ok(!r.body.includes('clave-de-prueba'));
});
t('cuerpo que no es JSON → 400', async () => {
  assert.strictEqual((await peticion('esto no es json')).statusCode, 400);
});
t('contraseña incorrecta → 401 y no llama a Brevo', async () => {
  const r = await peticion({ password: 'otra', filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] });
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(llamadas.length, 0);
});
t('sin contraseña → 401', async () => {
  const r = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] }) });
  assert.strictEqual(r.statusCode, 401);
});
t('5 fallos seguidos bloquean aunque luego sea correcta (429)', async () => {
  for (let i = 0; i < 5; i++) assert.strictEqual((await peticion({ password: 'mal' + i, filtros: [] }, { ip: '9.9.9.9' })).statusCode, 401);
  assert.strictEqual((await peticion({ filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] }, { ip: '9.9.9.9' })).statusCode, 429);
  assert.strictEqual(llamadas.length, 0);
});
t('otra IP no queda bloqueada', async () => {
  for (let i = 0; i < 5; i++) await peticion({ password: 'mal', filtros: [] }, { ip: '9.9.9.9' });
  respuestas.push({ status: 200, cuerpo: { contacts: [] } });
  assert.strictEqual((await peticion({ filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] }, { ip: '8.8.8.8' })).statusCode, 200);
});
t('sin filtros ni segmento → 400', async () => {
  assert.strictEqual((await peticion({ filtros: [] })).statusCode, 400);
});
t('atributo personal (NOMBRE) no permitido → 400 y lista el atributo', async () => {
  const r = await peticion({ filtros: [{ attr: 'NOMBRE', valor: 'Laura' }] });
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(r.body).noPermitidos, ['NOMBRE']);
  assert.strictEqual(llamadas.length, 0);
});
t('valor con comillas o paréntesis (intento de inyección) → 400', async () => {
  const r = await peticion({ filtros: [{ attr: 'SEARCH_CITY', valor: 'x"),equals(OPT_IN,true' }] });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(llamadas.length, 0);
});
t('más de 4 filtros → 400', async () => {
  const f = [1, 2, 3, 4, 5].map(() => ({ attr: 'SEARCH_CITY', valor: 'valencia' }));
  assert.strictEqual((await peticion({ filtros: f })).statusCode, 400);
});
t('segmento no válido → 400', async () => {
  assert.strictEqual((await peticion({ segmentId: '12; DROP', filtros: [] })).statusCode, 400);
});
t('búsqueda correcta: filtra, quita bajas, no devuelve atributos personales y usa la clave', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [
    c(1, 'a@x.com', { SEARCH_AUDIENCE: 'nuevo_con_saldo', SEARCH_IS_NEW: true, NOMBRE: 'Laura', LANGUAGE: 'es' }),
    c(2, 'b@x.com', { SEARCH_AUDIENCE: 'nuevo_con_saldo', SEARCH_IS_NEW: false }),
    c(3, 'baja@x.com', { SEARCH_AUDIENCE: 'nuevo_con_saldo', SEARCH_IS_NEW: true }, { emailBlacklisted: true }),
    c(4, 'd@x.com', { SEARCH_AUDIENCE: 'nuevo_con_saldo', SEARCH_IS_NEW: true, SEARCH_CITY: 'valencia' }),
  ] } });
  const r = await peticion({ filtros: [{ attr: 'SEARCH_AUDIENCE', valor: 'nuevo_con_saldo' }, { attr: 'SEARCH_IS_NEW', valor: 'true' }] });
  const o = JSON.parse(r.body);
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(o.contactos.map((x) => x.id), [1, 4]);
  assert.strictEqual(o.coincidencias, 2);
  assert.strictEqual(o.revisados, 4);
  assert.ok(!('NOMBRE' in o.contactos[0].atributos), 'NOMBRE no debe salir');
  assert.strictEqual(o.contactos[0].atributos.LANGUAGE, 'es');
  assert.ok(llamadas[0].url.includes('filter=equals(SEARCH_AUDIENCE%2C%22nuevo_con_saldo%22)'.replace('%2C', encodeURIComponent(','))));
  assert.strictEqual(llamadas[0].headers['api-key'], 'clave-de-prueba');
});
t('booleanos sin comillas en el filtro de Brevo', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [] } });
  await peticion({ filtros: [{ attr: 'HOST_HAS_IB', valor: 'true' }] });
  assert.ok(decodeURIComponent(llamadas[0].url).includes('filter=equals(HOST_HAS_IB,true)'));
});
t('si Brevo rechaza el número sin comillas (400), reintenta con comillas', async () => {
  respuestas.push({ status: 400, cuerpo: { message: 'x' } }, { status: 200, cuerpo: { contacts: [c(7, 'n@x.com', { SEARCH_DAYS_TO_TRIP: 3 })] } });
  const r = await peticion({ filtros: [{ attr: 'SEARCH_DAYS_TO_TRIP', valor: '3' }] });
  assert.strictEqual(llamadas.length, 2);
  assert.ok(decodeURIComponent(llamadas[0].url).includes('equals(SEARCH_DAYS_TO_TRIP,3)'));
  assert.ok(decodeURIComponent(llamadas[1].url).includes('equals(SEARCH_DAYS_TO_TRIP,"3")'));
  assert.strictEqual(JSON.parse(r.body).contactos.length, 1);
});
t('si el filtro siempre da 400, consulta sin filtro y filtra aquí', async () => {
  respuestas.push({ status: 400, cuerpo: {} }, { status: 400, cuerpo: {} }, { status: 200, cuerpo: { contacts: [
    c(1, 'a@x.com', { SEARCH_CITY: 'Valencia' }), c(2, 'b@x.com', { SEARCH_CITY: 'Madrid' })] } });
  const r = await peticion({ filtros: [{ attr: 'SEARCH_CITY', valor: 'valencia' }] });
  assert.strictEqual(llamadas.length, 3);
  assert.ok(!llamadas[2].url.includes('filter='));
  assert.deepStrictEqual(JSON.parse(r.body).contactos.map((x) => x.id), [1]);
});
t('segmento: se envía segmentId y el filtro adicional se aplica aquí', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [c(1, 'a@x.com', { CURRENT_BOOKING_STATUS: 'on_rent' }), c(2, 'b@x.com', { CURRENT_BOOKING_STATUS: 'booked' })] } });
  const r = await peticion({ segmentId: 79, filtros: [{ attr: 'CURRENT_BOOKING_STATUS', valor: 'booked' }] });
  assert.ok(llamadas[0].url.includes('segmentId=79'));
  assert.deepStrictEqual(JSON.parse(r.body).contactos.map((x) => x.id), [2]);
});
t('solo segmento, sin filtros', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [c(1, 'a@x.com', {})] } });
  const r = await peticion({ segmentId: 78, filtros: [] });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!llamadas[0].url.includes('filter='));
});
t('atributo de opción múltiple (TIPO_USUARIO) coincide con un valor de la lista', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [c(1, 'a@x.com', { TIPO_USUARIO: ['Rider', 'Host'] }), c(2, 'b@x.com', { TIPO_USUARIO: ['Rider'] })] } });
  const r = await peticion({ filtros: [{ attr: 'LANGUAGE', valor: 'es' }, { attr: 'TIPO_USUARIO', valor: 'Host' }] });
  respuestas.length = 0;
  assert.ok(r.statusCode === 200);
});
t('máximo 10 resultados aunque pidan más', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: Array.from({ length: 30 }, (_, i) => c(i + 1, 'u' + i + '@x.com', { SEARCH_IS_NEW: true })) } });
  const r = await peticion({ max: 50, filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] });
  assert.strictEqual(JSON.parse(r.body).contactos.length, 10);
  assert.strictEqual(JSON.parse(r.body).coincidencias, 30);
});
t('Brevo falla (500) → 502 sin filtrar detalles', async () => {
  respuestas.push({ status: 500, cuerpo: { message: 'secreto interno' } });
  const r = await peticion({ filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] });
  assert.strictEqual(r.statusCode, 502);
  assert.ok(!r.body.includes('secreto interno'));
});
t('una lista propia en ATRIBUTOS_PERMITIDOS sustituye a la de serie', async () => {
  process.env.ATRIBUTOS_PERMITIDOS = 'MI_ATRIBUTO';
  respuestas.push({ status: 200, cuerpo: { contacts: [] } });
  const a = await peticion({ filtros: [{ attr: 'MI_ATRIBUTO', valor: 'si' }] });
  const b = await peticion({ filtros: [{ attr: 'HOST_HAS_IB', valor: 'true' }] });
  delete process.env.ATRIBUTOS_PERMITIDOS;
  assert.strictEqual(a.statusCode, 200);
  assert.strictEqual(b.statusCode, 400);
});
t('los registros no contienen emails, ni la contraseña, ni la clave', async () => {
  respuestas.push({ status: 200, cuerpo: { contacts: [c(1, 'privado@x.com', { SEARCH_IS_NEW: true })] } });
  await peticion({ filtros: [{ attr: 'SEARCH_IS_NEW', valor: 'true' }] });
  await peticion({ password: 'mal', filtros: [] });
  const todo = logs.join('\n');
  assert.ok(todo.includes('consulta'));
  assert.ok(!todo.includes('privado@x.com') && !todo.includes('frase larga') && !todo.includes('clave-de-prueba'));
});

(async () => {
  let fallidas = 0;
  for (const [nombre, fn] of pruebas) {
    reset();
    try { await fn(); log0('ok   ' + nombre); }
    catch (e) { fallidas++; log0('FALLA ' + nombre + '\n     ' + e.message); }
  }
  log0(fallidas ? '\n' + fallidas + ' prueba(s) fallida(s)' : '\nTodas las pruebas pasan (' + pruebas.length + ')');
  process.exit(fallidas ? 1 : 0);
})();
