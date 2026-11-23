import { parseDocumento, validarNumero } from '../../shared/dni.js';
import { ahora, err } from '../util.js';
import { tx } from '../db.js';
import { auditar, leerConfig, opcionesDni } from './config.js';
import { calcularTarifa } from './tarifas.js';
import { cajaActual } from './caja.js';

const SQL_VISITA = `
  SELECT v.*, p.dni, p.nombre AS persona_nombre,
         ui.nombre AS operador_ingreso_nombre, ue.nombre AS operador_egreso_nombre
  FROM visitas v
  JOIN personas p ON p.id = v.persona_id
  LEFT JOIN usuarios ui ON ui.id = v.operador_ingreso
  LEFT JOIN usuarios ue ON ue.id = v.operador_egreso`;

export function minutosEntre(desde, hasta) {
  const a = new Date(desde.replace(' ', 'T'));
  const b = new Date(hasta.replace(' ', 'T'));
  return Math.max(0, Math.round((b - a) / 60000));
}

function mapVisita(v) {
  if (!v) return null;
  return {
    id: v.id,
    dni: v.dni,
    nombre: v.persona_nombre || null,
    cantidad: v.cantidad,
    ingreso: v.ingreso,
    egreso: v.egreso,
    estado: v.estado,
    operadorIngreso: v.operador_ingreso_nombre,
    operadorEgreso: v.operador_egreso_nombre,
    operadorIngresoId: v.operador_ingreso,
    motivoAnulacion: v.motivo_anulacion,
  };
}

export function obtenerVisita(db, id) {
  const v = mapVisita(db.prepare(`${SQL_VISITA} WHERE v.id = ?`).get(id));
  if (!v) throw err.noExiste('Ingreso inexistente');
  v.correcciones = db.prepare(`SELECT c.*, u.nombre AS usuario_nombre FROM visita_correcciones c JOIN usuarios u ON u.id = c.usuario_id WHERE visita_id = ? ORDER BY c.id`).all(id);
  v.ordenes = db.prepare('SELECT numero, importe, medio, estado, fecha FROM ordenes WHERE visita_id = ? ORDER BY numero').all(id);
  return v;
}

function visitaActivaPorDni(db, dni) {
  return mapVisita(db.prepare(`${SQL_VISITA} WHERE p.dni = ? AND v.estado = 'DENTRO'`).get(dni));
}

/** Procesa un escaneo/tipeo de DNI y determina si corresponde INGRESO o EGRESO. */
export function procesarEscaneo(db, raw, usuario) {
  const cfg = leerConfig(db);
  const p = parseDocumento(raw, opcionesDni(cfg));
  if (!p.ok) throw err.validacion(p.error);

  const persona = db.prepare('SELECT * FROM personas WHERE dni = ?').get(p.dni);
  let historial = { visitas: 0, ultima: null };
  if (persona) {
    const h = db.prepare("SELECT COUNT(*) AS n, MAX(ingreso) AS ultima FROM visitas WHERE persona_id = ? AND estado = 'FINALIZADA'").get(persona.id);
    historial = { visitas: h.n, ultima: h.ultima };
  }
  const caja = cajaActual(db, usuario, cfg);
  const activa = visitaActivaPorDni(db, p.dni);
  let nombre = null;
  if (cfg.guardar_nombre) nombre = persona?.nombre || [p.apellido, p.nombre].filter(Boolean).join(', ') || null;

  const res = {
    dni: p.dni,
    nombre,
    apellido: p.apellido,
    sexo: p.sexo,
    fechaNacimiento: p.fechaNacimiento,
    origen: p.origen,
    historial,
    cajaAbierta: !!caja,
    accion: activa ? 'EGRESO' : 'INGRESO',
    visita: activa,
    tarifa: null,
    errorTarifa: null,
  };
  if (activa) {
    res.visita.minutos = minutosEntre(activa.ingreso, ahora());
    try {
      res.tarifa = calcularTarifa(db, activa.cantidad);
    } catch (e) {
      res.errorTarifa = e.message;
    }
  }
  return res;
}

export function validarCantidad(cantidad, cfg) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 1) throw err.validacion('La cantidad de personas debe ser un número entero mayor a 0');
  if (n > cfg.max_personas) throw err.validacion(`La cantidad máxima configurada es ${cfg.max_personas} personas`);
  return n;
}

export function registrarIngreso(db, { dni, cantidad, nombre, idemKey }, usuario, ip) {
  const cfg = leerConfig(db);
  const v = validarNumero(dni, opcionesDni(cfg));
  if (!v.ok) throw err.validacion(v.error);
  const cant = validarCantidad(cantidad, cfg);
  if (idemKey !== undefined && (typeof idemKey !== 'string' || idemKey.length > 100)) throw err.validacion('Clave de operación inválida');

  return tx(db, () => {
    if (idemKey) {
      const prev = db.prepare('SELECT id FROM visitas WHERE idem_key = ?').get(idemKey);
      if (prev) return { ...obtenerVisita(db, prev.id), idempotente: true };
    }
    if (cfg.ingreso_requiere_caja && !cajaActual(db, usuario, cfg))
      throw err.conflicto('CAJA_CERRADA', 'Debe abrir la caja antes de registrar ingresos');

    let persona = db.prepare('SELECT * FROM personas WHERE dni = ?').get(v.dni);
    const nombreGuardar = cfg.guardar_nombre && nombre ? String(nombre).slice(0, 120) : null;
    if (!persona) {
      const r = db.prepare('INSERT INTO personas (dni, nombre, creado) VALUES (?,?,?)').run(v.dni, nombreGuardar, ahora());
      persona = { id: Number(r.lastInsertRowid) };
    } else if (nombreGuardar && !persona.nombre) {
      db.prepare('UPDATE personas SET nombre = ? WHERE id = ?').run(nombreGuardar, persona.id);
    }

    const activa = db.prepare("SELECT id, ingreso, cantidad FROM visitas WHERE persona_id = ? AND estado = 'DENTRO'").get(persona.id);
    if (activa)
      throw err.conflicto('YA_DENTRO', `Este DNI ya tiene un ingreso activo desde ${activa.ingreso.slice(11, 16)} (${activa.cantidad} persona/s). Registre primero el egreso.`, { visitaId: activa.id });

    const r = db.prepare("INSERT INTO visitas (persona_id, cantidad, ingreso, estado, operador_ingreso, idem_key) VALUES (?,?,?,'DENTRO',?,?)")
      .run(persona.id, cant, ahora(), usuario.id, idemKey || null);
    const id = Number(r.lastInsertRowid);
    auditar(db, { usuario, ip, accion: 'INGRESO', entidad: 'visita', entidadId: id, detalle: { cantidad: cant } });
    return obtenerVisita(db, id);
  });
}

function validarMotivo(motivo) {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw err.validacion('Indique el motivo (mínimo 3 caracteres)');
  return motivo.trim().slice(0, 300);
}

export function corregirVisita(db, id, { cantidad, motivo }, usuario, ip) {
  const cfg = leerConfig(db);
  const cant = validarCantidad(cantidad, cfg);
  const mot = validarMotivo(motivo);
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM visitas WHERE id = ?').get(id);
    if (!v) throw err.noExiste('Ingreso inexistente');
    if (v.estado !== 'DENTRO') throw err.conflicto('NO_EDITABLE', 'Solo se pueden corregir ingresos activos. Si ya fue cobrado, un administrador debe anular la orden.');
    if (v.cantidad === cant) throw err.validacion('La cantidad es igual a la registrada');
    db.prepare('UPDATE visitas SET cantidad = ? WHERE id = ?').run(cant, id);
    db.prepare('INSERT INTO visita_correcciones (visita_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, fecha) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'cantidad', String(v.cantidad), String(cant), mot, usuario.id, ahora());
    auditar(db, { usuario, ip, accion: 'INGRESO_CORREGIDO', entidad: 'visita', entidadId: id, detalle: { antes: v.cantidad, despues: cant, motivo: mot } });
    return obtenerVisita(db, id);
  });
}

export function anularVisita(db, id, motivo, usuario, ip) {
  const cfg = leerConfig(db);
  const mot = validarMotivo(motivo);
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM visitas WHERE id = ?').get(id);
    if (!v) throw err.noExiste('Ingreso inexistente');
    if (v.estado !== 'DENTRO') throw err.conflicto('NO_ANULABLE', 'Solo se pueden anular ingresos activos (sin cobrar)');
    if (usuario.rol !== 'admin') {
      const min = minutosEntre(v.ingreso, ahora());
      if (v.operador_ingreso !== usuario.id || min > cfg.anulacion_operador_minutos)
        throw err.prohibido(`Solo puede anular sus propios ingresos dentro de los ${cfg.anulacion_operador_minutos} minutos. Solicite a un administrador.`);
    }
    db.prepare("UPDATE visitas SET estado = 'ANULADA', motivo_anulacion = ?, egreso = ?, operador_egreso = ? WHERE id = ?").run(mot, ahora(), usuario.id, id);
    db.prepare('INSERT INTO visita_correcciones (visita_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, fecha) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'estado', 'DENTRO', 'ANULADA', mot, usuario.id, ahora());
    auditar(db, { usuario, ip, accion: 'INGRESO_ANULADO', entidad: 'visita', entidadId: id, detalle: { motivo: mot } });
    return obtenerVisita(db, id);
  });
}

export function listarActivas(db) {
  const ahoraStr = ahora();
  return db.prepare(`${SQL_VISITA} WHERE v.estado = 'DENTRO' ORDER BY v.ingreso`).all().map((r) => ({ ...mapVisita(r), minutos: minutosEntre(r.ingreso, ahoraStr) }));
}
