import { ahora, err } from '../util.js';
import { tx } from '../db.js';
import { auditar, leerConfig } from './config.js';
import { calcularTarifa } from './tarifas.js';
import { cajaActual } from './caja.js';

const SQL_ORDEN = `
  SELECT o.*, p.dni, p.nombre AS persona_nombre, v.ingreso, v.egreso, v.estado AS visita_estado,
         u.nombre AS operador_nombre, uv.nombre AS verificado_por_nombre, ua.nombre AS anulada_por_nombre
  FROM ordenes o
  JOIN visitas v ON v.id = o.visita_id
  JOIN personas p ON p.id = v.persona_id
  JOIN usuarios u ON u.id = o.operador_id
  LEFT JOIN usuarios uv ON uv.id = o.verificado_por
  LEFT JOIN usuarios ua ON ua.id = o.anulada_por`;

export function mapOrden(o) {
  if (!o) return null;
  return {
    numero: o.numero,
    visitaId: o.visita_id,
    cajaId: o.caja_id,
    dni: o.dni,
    nombre: o.persona_nombre,
    cantidad: o.cantidad,
    ingreso: o.ingreso,
    egreso: o.egreso,
    importe: o.importe,
    medio: o.medio,
    estado: o.estado,
    referencia: o.referencia,
    recibido: o.recibido,
    vuelto: o.vuelto,
    operador: o.operador_nombre,
    operadorId: o.operador_id,
    verificadoPor: o.verificado_por_nombre,
    verificadoEn: o.verificado_en,
    anuladaPor: o.anulada_por_nombre,
    anuladaEn: o.anulada_en,
    motivoAnulacion: o.motivo_anulacion,
    fecha: o.fecha,
  };
}

export function obtenerOrden(db, numero) {
  const o = mapOrden(db.prepare(`${SQL_ORDEN} WHERE o.numero = ?`).get(numero));
  if (!o) throw err.noExiste('Orden inexistente');
  return o;
}

export function registrarIngresoPagado(db, datos, usuario, ip) {
  const cfg = leerConfig(db);
  const dni = String(datos.dni || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!dni) throw err.validacion('DNI inválido');
  const cantidad = Number(datos.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > cfg.max_personas)
    throw err.validacion(`La cantidad debe estar entre 1 y ${cfg.max_personas}`);
  const tarifaId = Number(datos.tarifaId);
  if (!Number.isInteger(tarifaId)) throw err.validacion('Seleccione una tarifa');
  const medio = datos.medio;
  if (!['EFECTIVO', 'TRANSFERENCIA'].includes(medio)) throw err.validacion('Seleccione efectivo o transferencia');
  if (typeof datos.idemKey !== 'string' || datos.idemKey.length < 8 || datos.idemKey.length > 100)
    throw err.validacion('Falta la clave única de operación');

  return tx(db, () => {
    const previa = db.prepare('SELECT numero FROM ordenes WHERE idem_key = ?').get(datos.idemKey);
    if (previa) return { ...obtenerOrden(db, previa.numero), idempotente: true };

    const tarifa = db.prepare('SELECT * FROM tarifas WHERE id = ?').get(tarifaId);
    if (!tarifa || !tarifa.activa) throw err.conflicto('TARIFA_INACTIVA', 'La tarifa seleccionada no está disponible');
    if ((tarifa.cantidad || tarifa.desde) !== cantidad)
      throw err.conflicto('TARIFA_INCOMPATIBLE', 'La tarifa seleccionada no corresponde a la cantidad de personas');

    const caja = cajaActual(db, usuario, cfg);
    if (!caja) throw err.conflicto('CAJA_CERRADA', 'Debe abrir la caja antes de registrar ingresos');

    let persona = db.prepare('SELECT * FROM personas WHERE dni = ?').get(dni);
    const nombre = datos.nombre ? String(datos.nombre).trim().slice(0, 120) : null;
    const apellido = datos.apellido ? String(datos.apellido).trim().slice(0, 120) : null;
    const sexo = datos.sexo ? String(datos.sexo).trim().slice(0, 20) : null;
    const nacimiento = datos.fechaNacimiento ? String(datos.fechaNacimiento).trim().slice(0, 30) : null;
    if (!persona) {
      const r = db.prepare(`INSERT INTO personas (dni, nombre, apellido, sexo, fecha_nacimiento, creado)
        VALUES (?,?,?,?,?,?)`).run(dni, nombre, apellido, sexo, nacimiento, ahora());
      persona = { id: Number(r.lastInsertRowid) };
    } else {
      db.prepare(`UPDATE personas SET
        nombre=COALESCE(NULLIF(nombre,''),?), apellido=COALESCE(NULLIF(apellido,''),?),
        sexo=COALESCE(NULLIF(sexo,''),?), fecha_nacimiento=COALESCE(NULLIF(fecha_nacimiento,''),?)
        WHERE id=?`).run(nombre, apellido, sexo, nacimiento, persona.id);
    }

    const activa = db.prepare("SELECT id FROM visitas WHERE persona_id = ? AND estado = 'DENTRO'").get(persona.id);
    if (activa) throw err.conflicto('YA_DENTRO', 'Esta persona ya tiene un ingreso activo');

    const t = ahora();
    const nombreTitular = [apellido, nombre].filter(Boolean).join(', ') || null;
    const rVisita = db.prepare(`INSERT INTO visitas
      (persona_id, cantidad, ingreso, estado, operador_ingreso, idem_key, tarifa_id, tarifa_nombre, tarifa_cantidad, importe_snapshot, medio_pago, estado_pago)
      VALUES (?,?,?, 'DENTRO', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(persona.id, cantidad, t, usuario.id, datos.idemKey,
        tarifa.id, tarifa.nombre || `Tarifa ${tarifa.desde}`, tarifa.cantidad || tarifa.desde,
        tarifa.precio, medio, medio === 'EFECTIVO' ? 'PAGADO' : (datos.verificada === true ? 'PAGADO' : 'PENDIENTE'));
    const visitaId = Number(rVisita.lastInsertRowid);

    let estado = medio === 'EFECTIVO' ? 'PAGADO' : (datos.verificada === true ? 'PAGADO' : 'PENDIENTE');
    let recibido = null;
    let vuelto = null;
    if (medio === 'EFECTIVO') {
      recibido = datos.recibido;
      if (!Number.isInteger(recibido) || recibido < tarifa.precio)
        throw err.validacion('El monto recibido es menor al total');
      vuelto = recibido - tarifa.precio;
    } else if (datos.verificada !== true) {
      throw err.conflicto('PAGO_NO_CONFIRMADO', 'Debe confirmar que recibió y verificó la transferencia');
    }

    const rOrden = db.prepare(`INSERT INTO ordenes
      (visita_id, caja_id, cantidad, importe, medio, estado, referencia, recibido, vuelto,
       operador_id, verificado_por, verificado_en, fecha, idem_key, tarifa_id, tarifa_nombre, tarifa_cantidad, nombre_titular)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(visitaId, caja.id, cantidad, tarifa.precio, medio, estado,
        medio === 'TRANSFERENCIA' ? String(datos.referencia || '').trim().slice(0, 120) || null : null,
        recibido, vuelto, usuario.id,
        medio === 'TRANSFERENCIA' ? usuario.id : null,
        medio === 'TRANSFERENCIA' ? t : null, t, datos.idemKey,
        tarifa.id, tarifa.nombre || `Tarifa ${tarifa.desde}`, tarifa.cantidad || tarifa.desde, nombreTitular);
    const numero = Number(rOrden.lastInsertRowid);
    if (medio === 'EFECTIVO' && tarifa.precio > 0) {
      db.prepare(`INSERT INTO movimientos_caja
        (caja_id, tipo, concepto, importe, orden_numero, usuario_id, fecha)
        VALUES (?, 'COBRO', ?, ?, ?, ?, ?)`)
        .run(caja.id, `Cobro ingreso N° ${numero}`, tarifa.precio, numero, usuario.id, t);
    }
    auditar(db, { usuario, ip, accion: 'INGRESO_PAGADO', entidad: 'orden', entidadId: numero,
      detalle: { visita: visitaId, dni, cantidad, tarifaId: tarifa.id, importe: tarifa.precio, medio } });
    return obtenerOrden(db, numero);
  });
}

export function registrarEgreso(db, visitaId, usuario, ip) {
  if (!Number.isInteger(visitaId)) throw err.validacion('Ingreso inválido');
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM visitas WHERE id = ?').get(visitaId);
    if (!v) throw err.noExiste('Ingreso inexistente');
    if (v.estado !== 'DENTRO') throw err.conflicto('NO_ACTIVO', 'El ingreso no está activo');
    const t = ahora();
    db.prepare("UPDATE visitas SET estado='FINALIZADA', egreso=?, operador_egreso=? WHERE id=?")
      .run(t, usuario.id, visitaId);
    auditar(db, { usuario, ip, accion: 'EGRESO', entidad: 'visita', entidadId: visitaId, detalle: { egreso: t } });
    return obtenerVisitaSimple(db, visitaId);
  });
}

function obtenerVisitaSimple(db, id) {
  return db.prepare(`SELECT v.*, p.dni, p.nombre, p.apellido
    FROM visitas v JOIN personas p ON p.id=v.persona_id WHERE v.id=?`).get(id);
}

/**
 * Registra el egreso y el cobro de una visita en UNA transacción:
 * orden + cierre de visita + movimiento de caja (si es efectivo) + auditoría.
 * Idempotente por idemKey: un reintento devuelve la misma orden.
 */
export function cobrar(db, { visitaId, medio, recibido, referencia, verificada, idemKey }, usuario, ip) {
  const cfg = leerConfig(db);
  if (!Number.isInteger(visitaId)) throw err.validacion('Ingreso inválido');
  if (!['EFECTIVO', 'TRANSFERENCIA'].includes(medio)) throw err.validacion('Seleccione el medio de pago');
  if (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 100) throw err.validacion('Falta la clave única de operación');
  if (medio === 'EFECTIVO' && recibido != null && (!Number.isInteger(recibido) || recibido < 0)) throw err.validacion('Monto recibido inválido');
  const ref = referencia ? String(referencia).trim().slice(0, 120) : null;

  return tx(db, () => {
    const previa = db.prepare('SELECT numero FROM ordenes WHERE idem_key = ?').get(idemKey);
    if (previa) return { ...obtenerOrden(db, previa.numero), idempotente: true };

    const v = db.prepare('SELECT * FROM visitas WHERE id = ?').get(visitaId);
    if (!v) throw err.noExiste('Ingreso inexistente');
    if (v.estado !== 'DENTRO') {
      const o = db.prepare("SELECT numero FROM ordenes WHERE visita_id = ? AND estado <> 'ANULADA'").get(visitaId);
      if (o) throw err.conflicto('YA_COBRADO', `Este egreso ya fue cobrado (Orden N° ${o.numero})`, { numero: o.numero });
      throw err.conflicto('NO_ACTIVO', 'Este ingreso no está activo');
    }
    const caja = cajaActual(db, usuario, cfg);
    if (!caja) throw err.conflicto('CAJA_CERRADA', 'Debe abrir la caja antes de cobrar');

    const { precio } = calcularTarifa(db, v.cantidad);
    let estado, vuelto = null, rec = null;
    if (medio === 'EFECTIVO') {
      rec = recibido ?? precio;
      if (rec < precio) throw err.validacion('El monto entregado es menor al total a cobrar');
      vuelto = rec - precio;
      estado = 'PAGADO';
    } else {
      estado = verificada === true ? 'PAGADO' : 'PENDIENTE';
    }
    const t = ahora();
    const r = db.prepare(`INSERT INTO ordenes (visita_id, caja_id, cantidad, importe, medio, estado, referencia, recibido, vuelto, operador_id, verificado_por, verificado_en, fecha, idem_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.id, caja.id, v.cantidad, precio, medio, estado, medio === 'TRANSFERENCIA' ? ref : null, rec, vuelto, usuario.id,
      medio === 'TRANSFERENCIA' && estado === 'PAGADO' ? usuario.id : null,
      medio === 'TRANSFERENCIA' && estado === 'PAGADO' ? t : null, t, idemKey,
    );
    const numero = Number(r.lastInsertRowid);
    db.prepare("UPDATE visitas SET estado='FINALIZADA', egreso=?, operador_egreso=? WHERE id=?").run(t, usuario.id, v.id);
    if (medio === 'EFECTIVO' && precio > 0) {
      db.prepare("INSERT INTO movimientos_caja (caja_id, tipo, concepto, importe, orden_numero, usuario_id, fecha) VALUES (?, 'COBRO', ?, ?, ?, ?, ?)")
        .run(caja.id, `Cobro orden N° ${numero}`, precio, numero, usuario.id, t);
    }
    auditar(db, { usuario, ip, accion: 'COBRO', entidad: 'orden', entidadId: numero, detalle: { visita: v.id, importe: precio, medio, estado } });
    return obtenerOrden(db, numero);
  });
}

export function verificarTransferencia(db, numero, referencia, usuario, ip) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM ordenes WHERE numero = ?').get(numero);
    if (!o) throw err.noExiste('Orden inexistente');
    if (o.medio !== 'TRANSFERENCIA' || o.estado !== 'PENDIENTE') throw err.conflicto('NO_PENDIENTE', 'La orden no es una transferencia pendiente');
    const ref = referencia ? String(referencia).trim().slice(0, 120) : o.referencia;
    db.prepare("UPDATE ordenes SET estado='PAGADO', verificado_por=?, verificado_en=?, referencia=? WHERE numero=?").run(usuario.id, ahora(), ref, numero);
    auditar(db, { usuario, ip, accion: 'TRANSFERENCIA_VERIFICADA', entidad: 'orden', entidadId: numero, detalle: { referencia: ref } });
    return obtenerOrden(db, numero);
  });
}

/**
 * Anula una orden (solo administrador). Si fue en efectivo registra un contramovimiento
 * en la caja abierta. La visita vuelve a estado DENTRO para poder cobrarla correctamente.
 */
export function anularOrden(db, numero, motivo, usuario, ip) {
  if (usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede anular órdenes');
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw err.validacion('Indique el motivo de la anulación');
  const cfg = leerConfig(db);
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM ordenes WHERE numero = ?').get(numero);
    if (!o) throw err.noExiste('Orden inexistente');
    if (o.estado === 'ANULADA') throw err.conflicto('YA_ANULADA', 'La orden ya está anulada');
    const t = ahora();
    if (o.medio === 'EFECTIVO' && o.importe > 0) {
      const cajaOrig = db.prepare('SELECT * FROM cajas WHERE id = ?').get(o.caja_id);
      const destino = cajaOrig.estado === 'ABIERTA' ? cajaOrig : cajaActual(db, usuario, cfg);
      if (!destino) throw err.conflicto('CAJA_CERRADA', 'La caja de la orden está cerrada. Abra una caja para registrar la devolución del efectivo.');
      db.prepare("INSERT INTO movimientos_caja (caja_id, tipo, concepto, importe, orden_numero, usuario_id, fecha) VALUES (?, 'ANULACION', ?, ?, ?, ?, ?)")
        .run(destino.id, `Anulación orden N° ${numero}: ${motivo.trim().slice(0, 150)}`, -o.importe, numero, usuario.id, t);
    }
    db.prepare("UPDATE ordenes SET estado='ANULADA', anulada_por=?, anulada_en=?, motivo_anulacion=? WHERE numero=?").run(usuario.id, t, motivo.trim().slice(0, 300), numero);
    const v = db.prepare('SELECT * FROM visitas WHERE id = ?').get(o.visita_id);
    let visitaReabierta = false;
    const otraActiva = db.prepare("SELECT 1 FROM visitas WHERE persona_id = ? AND estado = 'DENTRO'").get(v.persona_id);
    if (!otraActiva) {
      db.prepare("UPDATE visitas SET estado='DENTRO', egreso=NULL, operador_egreso=NULL WHERE id=?").run(v.id);
      db.prepare('INSERT INTO visita_correcciones (visita_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, fecha) VALUES (?,?,?,?,?,?,?)')
        .run(v.id, 'estado', 'FINALIZADA', 'DENTRO', `Orden ${numero} anulada: ${motivo.trim()}`, usuario.id, t);
      visitaReabierta = true;
    }
    auditar(db, { usuario, ip, accion: 'ORDEN_ANULADA', entidad: 'orden', entidadId: numero, detalle: { motivo, importe: o.importe, medio: o.medio, visitaReabierta } });
    return { ...obtenerOrden(db, numero), visitaReabierta };
  });
}
