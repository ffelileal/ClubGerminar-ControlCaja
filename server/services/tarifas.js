import { ahora, err } from '../util.js';
import { tx } from '../db.js';
import { auditar } from './config.js';

export function listarTarifas(db) {
  const rows = db.prepare('SELECT * FROM tarifas ORDER BY desde, id').all();
  return rows.map((r) => ({
    id: r.id,
    desde: r.desde,
    cantidad: r.cantidad || r.desde,
    hasta: null,
    nombre: r.nombre || `Tarifa ${r.desde}`,
    descripcion: r.descripcion || '',
    precio: r.precio,
    activa: !!r.activa,
    creada: r.creada,
    personalizada: !!r.personalizada,
  }));
}

export function listarCompatibles(db, cantidad) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 1) throw err.validacion('Cantidad de personas inválida');
  return listarTarifas(db).filter((t) => t.activa && t.cantidad === n);
}

export function obtenerTarifa(db, id) {
  const r = db.prepare('SELECT * FROM tarifas WHERE id = ?').get(id);
  if (!r) throw err.noExiste('Tarifa inexistente');
  return listarTarifas(db).find((t) => t.id === r.id);
}

export function resolverTarifaId(db, valor) {
  const n = Number(valor);
  if (Number.isInteger(n)) {
    const porId = db.prepare('SELECT id FROM tarifas WHERE id = ?').get(n);
    if (porId) return porId.id;
    const porCantidad = db.prepare('SELECT id FROM tarifas WHERE desde = ?').get(n);
    if (porCantidad) return porCantidad.id;
  }
  throw err.noExiste('Tarifa inexistente');
}

export function crearTarifa(db, datos, usuario, ip) {
  const nombre = String(datos.nombre || '').trim();
  if (nombre.length < 2 || nombre.length > 80) throw err.validacion('Ingrese un nombre de tarifa válido');
  const cantidad = Number(datos.cantidad);
  const precio = Number(datos.precio);
  if (!Number.isInteger(cantidad) || cantidad < 1) throw err.validacion('Cantidad incluida inválida');
  if (!Number.isInteger(precio) || precio < 0) throw err.validacion('Precio inválido');
  return tx(db, () => {
    const existente = db.prepare('SELECT id FROM tarifas WHERE desde = ?').get(cantidad);
    if (existente) throw err.conflicto('TARIFA_EXISTE', `Ya existe una tarifa base para ${cantidad} persona/s`);
    const r = db.prepare(`INSERT INTO tarifas
      (desde, precio, nombre, descripcion, cantidad, activa, creada, personalizada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cantidad, precio, nombre, String(datos.descripcion || '').trim().slice(0, 300),
        cantidad, datos.activa === false ? 0 : 1, ahora(), datos.personalizada ? 1 : 0);
    const tarifa = obtenerTarifa(db, Number(r.lastInsertRowid));
    auditar(db, { usuario, ip, accion: 'TARIFA_CREADA', entidad: 'tarifa', entidadId: tarifa.id,
      detalle: { nombre, cantidad, precio } });
    return tarifa;
  });
}

/** Calcula el importe para una cantidad de personas. Lanza si no hay tarifa aplicable. */
export function calcularTarifa(db, cantidad) {
  const r = db.prepare('SELECT desde, precio FROM tarifas WHERE activa = 1 AND desde <= ? ORDER BY desde DESC LIMIT 1').get(cantidad);
  if (!r) throw err.conflicto('SIN_TARIFA', `No hay tarifa configurada para ${cantidad} persona(s). Un administrador debe configurarla.`);
  return { precio: r.precio, tramoDesde: r.desde };
}

export function actualizarTarifa(db, id, datos, usuario, ip) {
  const actual = obtenerTarifa(db, id);
  return tx(db, () => {
    const nombre = datos.nombre === undefined ? actual.nombre : String(datos.nombre).trim();
    if (nombre.length < 2 || nombre.length > 80) throw err.validacion('Ingrese un nombre de tarifa válido');
    const cantidad = datos.cantidad === undefined ? actual.cantidad : Number(datos.cantidad);
    const precio = datos.precio === undefined ? actual.precio : Number(datos.precio);
    if (!Number.isInteger(cantidad) || cantidad < 1) throw err.validacion('Cantidad incluida inválida');
    if (!Number.isInteger(precio) || precio < 0) throw err.validacion('Precio inválido');
    const duplicada = db.prepare('SELECT id FROM tarifas WHERE desde = ? AND id <> ?').get(cantidad, id);
    if (duplicada) throw err.conflicto('TARIFA_EXISTE', `Ya existe una tarifa base para ${cantidad} persona/s`);
    const activa = datos.activa === undefined ? (actual.activa ? 1 : 0) : (datos.activa ? 1 : 0);
    const descripcion = datos.descripcion === undefined ? actual.descripcion : String(datos.descripcion).trim().slice(0, 300);
    db.prepare(`UPDATE tarifas SET desde=?, precio=?, nombre=?, descripcion=?, cantidad=?, activa=? WHERE id=?`)
      .run(cantidad, precio, nombre, descripcion, cantidad, activa, id);
    const despues = obtenerTarifa(db, id);
    auditar(db, { usuario, ip, accion: 'TARIFA_MODIFICADA', entidad: 'tarifa', entidadId: id,
      detalle: { antes: actual, despues } });
    return despues;
  });
}

export function eliminarTarifa(db, id, usuario, ip) {
  return tx(db, () => {
    const actual = obtenerTarifa(db, id);
    const usada = db.prepare('SELECT 1 FROM ordenes WHERE tarifa_id = ? LIMIT 1').get(id);
    if (usada) {
      db.prepare('UPDATE tarifas SET activa = 0 WHERE id = ?').run(id);
      auditar(db, { usuario, ip, accion: 'TARIFA_DESACTIVADA', entidad: 'tarifa', entidadId: id, detalle: actual });
      return obtenerTarifa(db, id);
    }
    db.prepare('DELETE FROM tarifas WHERE id = ?').run(id);
    auditar(db, { usuario, ip, accion: 'TARIFA_ELIMINADA', entidad: 'tarifa', entidadId: id, detalle: actual });
    return { eliminada: true };
  });
}

/** Reemplaza la tabla completa de tarifas. tramos: [{desde, precio(centavos)}] */
export function guardarTarifas(db, tramos, usuario, ip) {
  if (!Array.isArray(tramos) || tramos.length === 0) throw err.validacion('Debe definir al menos un tramo de tarifa');
  const vistos = new Set();
  for (const t of tramos) {
    if (!Number.isInteger(t.desde) || t.desde < 1 || t.desde > 10000) throw err.validacion('Cantidad de personas inválida en tarifas');
    if (!Number.isInteger(t.precio) || t.precio < 0 || t.precio > 1e12) throw err.validacion('Precio inválido en tarifas');
    if (vistos.has(t.desde)) throw err.validacion(`Tramo duplicado: ${t.desde} persona(s)`);
    vistos.add(t.desde);
  }
  if (!vistos.has(1)) throw err.validacion('Debe existir una tarifa para 1 persona');
  return tx(db, () => {
    const antes = listarTarifas(db);
    db.exec('DELETE FROM tarifas');
    const ins = db.prepare('INSERT INTO tarifas (desde, precio) VALUES (?, ?)');
    for (const t of [...tramos].sort((a, b) => a.desde - b.desde)) ins.run(t.desde, t.precio);
    const despues = listarTarifas(db);
    auditar(db, { usuario, ip, accion: 'TARIFAS_MODIFICADAS', entidad: 'tarifas', detalle: { antes, despues } });
    return despues;
  });
}
