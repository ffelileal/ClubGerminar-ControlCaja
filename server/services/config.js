import { CONFIG_DEFAULTS } from '../db.js';
import { ahora, err } from '../util.js';

const NUMERICAS = new Set(['dni_min', 'dni_max', 'max_personas', 'botones_cantidad', 'backup_retencion', 'anulacion_operador_minutos']);
const BOOLEANAS = new Set([
  'dni_alfanumerico', 'guardar_nombre', 'ocultar_dni_operador', 'caja_unica',
  'ingreso_requiere_caja', 'cierre_pendientes_solo_admin', 'operador_puede_retirar',
]);

export function leerConfig(db) {
  const rows = db.prepare('SELECT clave, valor FROM config').all();
  const c = { ...CONFIG_DEFAULTS };
  for (const r of rows) c[r.clave] = r.valor;
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (NUMERICAS.has(k)) out[k] = Number(v);
    else if (BOOLEANAS.has(k)) out[k] = v === '1' || v === 'true';
    else out[k] = v;
  }
  return out;
}

export function opcionesDni(cfg) {
  return { min: cfg.dni_min, max: cfg.dni_max, alfanumerico: cfg.dni_alfanumerico };
}

export function guardarConfig(db, cambios, usuario, ip) {
  const actual = leerConfig(db);
  const upd = db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  const aplicados = {};
  for (const [k, v] of Object.entries(cambios)) {
    if (!(k in CONFIG_DEFAULTS)) continue;
    let valor;
    if (NUMERICAS.has(k)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw err.validacion(`Valor inválido para ${k}`);
      valor = String(n);
    } else if (BOOLEANAS.has(k)) valor = v ? '1' : '0';
    else valor = String(v ?? '').slice(0, 500);
    upd.run(k, valor);
    if (String(actual[k]) !== String(NUMERICAS.has(k) ? Number(valor) : BOOLEANAS.has(k) ? valor === '1' : valor))
      aplicados[k] = { antes: actual[k], despues: valor };
  }
  const nuevo = leerConfig(db);
  if (nuevo.dni_min < 1 || nuevo.dni_max < nuevo.dni_min) throw err.validacion('Rango de dígitos de DNI inválido');
  if (nuevo.max_personas < 1) throw err.validacion('Máximo de personas inválido');
  auditar(db, { usuario, ip, accion: 'CONFIG_MODIFICADA', entidad: 'config', detalle: aplicados });
  return nuevo;
}

export function auditar(db, { usuario, usuarioId, ip, accion, entidad, entidadId, detalle }) {
  db.prepare('INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle, ip, fecha) VALUES (?,?,?,?,?,?,?)').run(
    usuario?.id ?? usuarioId ?? null,
    accion,
    entidad ?? null,
    entidadId != null ? String(entidadId) : null,
    detalle ? JSON.stringify(detalle) : null,
    ip ?? null,
    ahora(),
  );
}
