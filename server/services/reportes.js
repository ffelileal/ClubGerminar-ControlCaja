import fs from 'node:fs';
import path from 'node:path';
import { ahora, hoy, sumarDias, err } from '../util.js';
import { auditar } from './config.js';

// ---------------- Dashboard ----------------
export function dashboard(db, dias = 30) {
  const d = hoy();
  const desde = sumarDias(d, -(dias - 1));
  const dentro = db.prepare("SELECT COUNT(*) AS grupos, COALESCE(SUM(cantidad),0) AS personas FROM visitas WHERE estado='DENTRO'").get();
  const ingresos = db.prepare("SELECT COUNT(*) AS grupos, COALESCE(SUM(cantidad),0) AS personas FROM visitas WHERE substr(ingreso,1,10)=? AND estado<>'ANULADA'").get(d);
  const egresos = db.prepare("SELECT COUNT(*) AS grupos, COALESCE(SUM(cantidad),0) AS personas FROM visitas WHERE substr(egreso,1,10)=? AND estado='FINALIZADA'").get(d);
  const rec = db.prepare(`SELECT COUNT(*) AS operaciones,
      COALESCE(SUM(importe),0) AS total,
      COALESCE(SUM(CASE WHEN medio='EFECTIVO' THEN importe END),0) AS efectivo,
      COALESCE(SUM(CASE WHEN medio='TRANSFERENCIA' THEN importe END),0) AS transferencia,
      COALESCE(SUM(CASE WHEN estado='PENDIENTE' THEN importe END),0) AS pendiente
    FROM ordenes WHERE substr(fecha,1,10)=? AND estado<>'ANULADA'`).get(d);

  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, grupos: 0, personas: 0 }));
  for (const r of db.prepare("SELECT CAST(substr(ingreso,12,2) AS INTEGER) AS h, COUNT(*) AS g, SUM(cantidad) AS p FROM visitas WHERE substr(ingreso,1,10)=? AND estado<>'ANULADA' GROUP BY h").all(d)) {
    horas[r.h] = { hora: r.h, grupos: r.g, personas: r.p };
  }

  const serie = [];
  const idx = {};
  for (let i = 0; i < dias; i++) {
    const f = sumarDias(desde, i);
    idx[f] = serie.length;
    serie.push({ fecha: f, personas: 0, grupos: 0, efectivo: 0, transferencia: 0 });
  }
  for (const r of db.prepare("SELECT substr(ingreso,1,10) AS f, COUNT(*) AS g, SUM(cantidad) AS p FROM visitas WHERE substr(ingreso,1,10) BETWEEN ? AND ? AND estado<>'ANULADA' GROUP BY f").all(desde, d)) {
    if (r.f in idx) Object.assign(serie[idx[r.f]], { grupos: r.g, personas: r.p });
  }
  for (const r of db.prepare(`SELECT substr(fecha,1,10) AS f,
      COALESCE(SUM(CASE WHEN medio='EFECTIVO' THEN importe END),0) AS e,
      COALESCE(SUM(CASE WHEN medio='TRANSFERENCIA' THEN importe END),0) AS t
      FROM ordenes WHERE substr(fecha,1,10) BETWEEN ? AND ? AND estado<>'ANULADA' GROUP BY f`).all(desde, d)) {
    if (r.f in idx) Object.assign(serie[idx[r.f]], { efectivo: r.e, transferencia: r.t });
  }
  const comprobantes = db.prepare("SELECT COUNT(*) AS cantidad FROM comprobantes WHERE substr(creado,1,10)=?").get(d);
  const pagosPendientes = db.prepare("SELECT COUNT(*) AS cantidad, COALESCE(SUM(importe),0) AS total FROM ordenes WHERE estado='PENDIENTE'").get();
  const tarifasMasUsadas = db.prepare(`SELECT COALESCE(tarifa_nombre,'Tarifa') AS nombre, COUNT(*) AS usos
    FROM ordenes WHERE estado <> 'ANULADA' GROUP BY COALESCE(tarifa_nombre,'Tarifa') ORDER BY usos DESC LIMIT 10`).all();
  return {
    fecha: d, dentro, ingresos, egresos, recaudacion: rec, porHora: horas, serie,
    comprobantesGenerados: comprobantes.cantidad,
    pagosPendientes,
    tarifasMasUsadas,
  };
}

// ---------------- Historial ----------------
function rangoFechas(f, campo, where, params) {
  if (f.desde) { where.push(`substr(${campo},1,10) >= ?`); params.push(String(f.desde).slice(0, 10)); }
  if (f.hasta) { where.push(`substr(${campo},1,10) <= ?`); params.push(String(f.hasta).slice(0, 10)); }
}

export function historialVisitas(db, f = {}, { limite = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  rangoFechas(f, 'v.ingreso', where, params);
  if (f.dni) { where.push('p.dni = ?'); params.push(String(f.dni).replace(/\D/g, '').replace(/^0+/, '') || String(f.dni)); }
  if (f.estado) { where.push('v.estado = ?'); params.push(f.estado); }
  if (f.medio) { where.push('o.medio = ?'); params.push(f.medio); }
  if (f.operador) { where.push('(v.operador_ingreso = ? OR v.operador_egreso = ?)'); params.push(Number(f.operador), Number(f.operador)); }
  if (f.numero) { where.push('o.numero = ?'); params.push(Number(f.numero)); }
  if (f.q) {
    const q = String(f.q).trim();
    where.push('(p.dni LIKE ? OR o.numero = ?)');
    params.push(`%${q.replace(/\D/g, '') || q}%`, Number(q.replace(/\D/g, '')) || -1);
  }
  const base = `FROM visitas v JOIN personas p ON p.id = v.persona_id
    LEFT JOIN ordenes o ON o.visita_id = v.id AND o.estado <> 'ANULADA'
    LEFT JOIN usuarios ui ON ui.id = v.operador_ingreso
    LEFT JOIN usuarios ue ON ue.id = v.operador_egreso
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
  const rows = db.prepare(`SELECT v.id, p.dni, v.cantidad, v.ingreso, v.egreso, v.estado,
      o.numero AS ordenNumero, o.importe, o.medio, o.estado AS estadoPago,
      o.tarifa_nombre AS tarifaNombre, o.nombre_titular AS titular,
      ui.nombre AS operadorIngreso, ue.nombre AS operadorEgreso ${base}
      ORDER BY v.ingreso DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
  return { rows, total };
}

export function historialOrdenes(db, f = {}, { limite = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  rangoFechas(f, 'o.fecha', where, params);
  if (f.dni) { where.push('p.dni = ?'); params.push(String(f.dni).replace(/\D/g, '').replace(/^0+/, '') || String(f.dni)); }
  if (f.estado) { where.push('o.estado = ?'); params.push(f.estado); }
  if (f.medio) { where.push('o.medio = ?'); params.push(f.medio); }
  if (f.operador) { where.push('o.operador_id = ?'); params.push(Number(f.operador)); }
  if (f.numero) { where.push('o.numero = ?'); params.push(Number(f.numero)); }
  if (f.caja) { where.push('o.caja_id = ?'); params.push(Number(f.caja)); }
  if (f.q) {
    const q = String(f.q).trim();
    where.push('(p.dni LIKE ? OR o.numero = ? OR o.referencia LIKE ?)');
    params.push(`%${q.replace(/\D/g, '') || q}%`, Number(q.replace(/\D/g, '')) || -1, `%${q}%`);
  }
  const base = `FROM ordenes o JOIN visitas v ON v.id = o.visita_id JOIN personas p ON p.id = v.persona_id
    JOIN usuarios u ON u.id = o.operador_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const tot = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN o.estado<>'ANULADA' THEN o.importe END),0) AS importe ${base}`).get(...params);
  const rows = db.prepare(`SELECT o.numero, p.dni, o.cantidad, o.fecha, v.ingreso, v.egreso, o.importe, o.medio, o.estado, o.referencia,
      o.caja_id AS cajaId, u.nombre AS operador ${base} ORDER BY o.numero DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
  return { rows, total: tot.n, totalImporte: tot.importe };
}

// ---------------- CSV ----------------
export function aCSV(columnas, filas) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [columnas.map((c) => esc(c.titulo)).join(';')];
  for (const f of filas) lineas.push(columnas.map((c) => esc(c.valor(f))).join(';'));
  return '\uFEFF' + lineas.join('\r\n');
}
export const montoCSV = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

// ---------------- Auditoría ----------------
export function listarAuditoria(db, f = {}, { limite = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  rangoFechas(f, 'a.fecha', where, params);
  if (f.usuario) { where.push('a.usuario_id = ?'); params.push(Number(f.usuario)); }
  if (f.accion) { where.push('a.accion = ?'); params.push(f.accion); }
  const base = `FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
  const rows = db.prepare(`SELECT a.*, u.nombre AS usuario_nombre ${base} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
  const acciones = db.prepare('SELECT DISTINCT accion FROM auditoria ORDER BY accion').all().map((r) => r.accion);
  return { rows, total, acciones };
}

// ---------------- Copias de seguridad ----------------
export function crearBackup(db, dir, retencion = 30, usuario = null, ip = null) {
  fs.mkdirSync(dir, { recursive: true });
  const nombre = `respaldo-${ahora().replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2')}.db`;
  const destino = path.join(dir, nombre);
  if (fs.existsSync(destino)) return { archivo: nombre };
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const archivos = listarBackups(dir);
  for (const a of archivos.slice(Math.max(1, retencion))) fs.rmSync(path.join(dir, a.archivo), { force: true });
  auditar(db, { usuario, ip, accion: 'BACKUP_CREADO', entidad: 'backup', entidadId: nombre });
  return { archivo: nombre };
}

export function listarBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^respaldo-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse()
    .map((f) => ({ archivo: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

export function rutaBackup(dir, archivo) {
  if (!/^respaldo-\d{8}-\d{6}\.db$/.test(String(archivo))) throw err.validacion('Archivo inválido');
  const p = path.join(dir, archivo);
  if (!fs.existsSync(p)) throw err.noExiste('Copia inexistente');
  return p;
}
