// Cliente HTTP con reintentos seguros para operaciones idempotentes.

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.mensaje || 'Error inesperado');
    this.status = status;
    this.codigo = data?.error;
    this.data = data || {};
  }
}

const listeners = new Set();
let conectado = true;
export function onConexion(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setConectado(v) {
  if (v !== conectado) {
    conectado = v;
    listeners.forEach((fn) => fn(v));
  }
}

let onNoAuth = () => {};
export function setOnNoAuth(fn) { onNoAuth = fn; }

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {{method?:string, body?:any, reintentos?:number}} opts
 * reintentos: solo usar >0 en operaciones idempotentes (con idemKey) o lecturas.
 */
export async function api(url, { method = 'GET', body, reintentos } = {}) {
  const intentos = (reintentos ?? (method === 'GET' ? 2 : 0)) + 1;
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    let res;
    try {
      res = await fetch('/api' + url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'control-caja' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Error de red: el servidor puede o no haber recibido la solicitud.
      setConectado(false);
      ultimoError = new ApiError(0, { error: 'SIN_CONEXION', mensaje: 'Sin conexión con el servidor. Verifique la red.' });
      if (i < intentos - 1) await esperar(800 * (i + 1));
      continue;
    }
    setConectado(true);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    if (res.ok) return data;
    if (res.status === 401 && !url.startsWith('/auth/login')) onNoAuth();
    if (res.status >= 500 && i < intentos - 1) { await esperar(800 * (i + 1)); ultimoError = new ApiError(res.status, data); continue; }
    throw new ApiError(res.status, data);
  }
  throw ultimoError;
}

export function nuevaClave() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

// Verificación periódica de conexión
setInterval(() => {
  fetch('/api/health', { cache: 'no-store' }).then((r) => setConectado(r.ok)).catch(() => setConectado(false));
}, 10000);
