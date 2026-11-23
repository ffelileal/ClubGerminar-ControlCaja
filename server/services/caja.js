import { ahora, err } from '../util.js';
import { tx } from '../db.js';
import { auditar, leerConfig } from './config.js';

/** Devuelve la caja abierta que corresponde al usuario (o null). */
export function cajaActual(db, usuario, cfg = leerConfig(db)) {
  if (cfg.caja_unica) return db.prepare("SELECT * FROM cajas WHERE estado = 'ABIERTA' ORDER BY id LIMIT 1").get() || null;
  return db.prepare("SELECT * FROM cajas WHERE estado = 'ABIERTA' AND usuario_apertura = ?").get(usuario.id) || null;
}

export function resumenCaja(db, cajaId) {
  const c = db.prepare('SELECT * FROM cajas WHERE id = ?').get(cajaId);
  if (!c) throw err.noExiste('Caja inexistente');
  const porTipo = Object.fromEntries(
    db.prepare('SELECT tipo, COALESCE(SUM(importe),0) AS total, COUNT(*) AS n FROM movimientos_caja WHERE caja_id = ? GROUP BY tipo').all(cajaId).map((r) => [r.tipo, r]),
  );
  const t = (k) => porTipo[k]?.total ?? 0;
  const transf = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN estado='PAGADO' THEN importe END),0) AS verificadas,
      COALESCE(SUM(CASE WHEN estado='PENDIENTE' THEN importe END),0) AS pendientes,
      COUNT(CASE WHEN estado='PENDIENTE' THEN 1 END) AS n_pendientes
    FROM ordenes WHERE caja_id = ? AND medio='TRANSFERENCIA'`).get(cajaId);
  const ops = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cantidad),0) AS personas FROM ordenes WHERE caja_id = ? AND estado <> 'ANULADA'`).get(cajaId);

  const efectivoCobrado = t('COBRO');
  const ingresosExtra = t('INGRESO');
  const gastos = -t('GASTO');
  const retiros = -t('RETIRO');
  const ajustes = t('AJUSTE') + t('ANULACION');
  const esperado = c.saldo_inicial + efectivoCobrado + ingresosExtra - gastos - retiros + ajustes;
  return {
    saldoInicial: c.saldo_inicial,
    efectivoCobrado,
    ingresosExtra,
    gastos,
    retiros,
    ajustes,
    transferenciasVerificadas: transf.verificadas,
    transferenciasPendientes: transf.pendientes,
    cantTransferenciasPendientes: transf.n_pendientes,
    operaciones: ops.n,
    personas: ops.personas,
    efectivoEsperado: esperado,
  };
}

function mapCaja(c) {
  if (!c) return null;
  return {
    id: c.id,
    estado: c.estado,
    apertura: c.apertura,
    cierre: c.cierre,
    saldoInicial: c.saldo_inicial,
    efectivoEsperado: c.efectivo_esperado,
    efectivoDeclarado: c.efectivo_declarado,
    diferencia: c.diferencia,
    observaciones: c.observaciones,
    usuarioApertura: c.u_ap,
    usuarioCierre: c.u_ci,
    resumen: c.resumen_json ? JSON.parse(c.resumen_json) : undefined,
  };
}

const SQL_CAJA = `SELECT c.*, ua.nombre AS u_ap, uc.nombre AS u_ci FROM cajas c
  JOIN usuarios ua ON ua.id = c.usuario_apertura LEFT JOIN usuarios uc ON uc.id = c.usuario_cierre`;

export function detalleCaja(db, id) {
  const c = mapCaja(db.prepare(`${SQL_CAJA} WHERE c.id = ?`).get(id));
  if (!c) throw err.noExiste('Caja inexistente');
  c.resumen = c.estado === 'CERRADA' && c.resumen ? c.resumen : resumenCaja(db, id);
  c.movimientos = db.prepare(`SELECT m.id, m.tipo, m.concepto, m.importe, m.orden_numero AS ordenNumero, m.fecha, u.nombre AS usuario
    FROM movimientos_caja m JOIN usuarios u ON u.id = m.usuario_id WHERE caja_id = ? ORDER BY m.id DESC`).all(id);
  return c;
}

export function estadoCaja(db, usuario) {
  const c = cajaActual(db, usuario);
  return c ? detalleCaja(db, c.id) : null;
}

export function abrirCaja(db, saldoInicial, usuario, ip) {
  if (!Number.isInteger(saldoInicial) || saldoInicial < 0) throw err.validacion('Ingrese un saldo inicial válido (0 o mayor)');
  const cfg = leerConfig(db);
  return tx(db, () => {
    if (cfg.caja_unica) {
      const ab = db.prepare("SELECT c.id, u.nombre FROM cajas c JOIN usuarios u ON u.id=c.usuario_apertura WHERE estado='ABIERTA'").get();
      if (ab) throw err.conflicto('CAJA_YA_ABIERTA', `Ya hay una caja abierta (N° ${ab.id}, abierta por ${ab.nombre})`);
    } else if (db.prepare("SELECT 1 FROM cajas WHERE estado='ABIERTA' AND usuario_apertura = ?").get(usuario.id)) {
      throw err.conflicto('CAJA_YA_ABIERTA', 'Usted ya tiene una caja abierta');
    }
    const r = db.prepare("INSERT INTO cajas (estado, apertura, usuario_apertura, saldo_inicial) VALUES ('ABIERTA',?,?,?)").run(ahora(), usuario.id, saldoInicial);
    const id = Number(r.lastInsertRowid);
    auditar(db, { usuario, ip, accion: 'CAJA_ABIERTA', entidad: 'caja', entidadId: id, detalle: { saldoInicial } });
    return detalleCaja(db, id);
  });
}

const TIPOS_MANUALES = { INGRESO: 1, RETIRO: -1, GASTO: -1, AJUSTE: 0 };

export function registrarMovimiento(db, { tipo, concepto, importe, signo }, usuario, ip) {
  const cfg = leerConfig(db);
  if (!(tipo in TIPOS_MANUALES)) throw err.validacion('Tipo de movimiento inválido');
  if (typeof concepto !== 'string' || concepto.trim().length < 3) throw err.validacion('Indique el concepto (mínimo 3 caracteres)');
  if (!Number.isInteger(importe) || importe <= 0) throw err.validacion('El importe debe ser mayor a 0');
  if (tipo === 'AJUSTE' && usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede registrar ajustes');
  if (tipo === 'RETIRO' && usuario.rol !== 'admin' && !cfg.operador_puede_retirar) throw err.prohibido('Solo un administrador puede registrar retiros');
  let s = TIPOS_MANUALES[tipo];
  if (tipo === 'AJUSTE') {
    if (signo !== 1 && signo !== -1) throw err.validacion('Indique si el ajuste suma o resta efectivo');
    s = signo;
  }
  return tx(db, () => {
    const caja = cajaActual(db, usuario, cfg);
    if (!caja) throw err.conflicto('CAJA_CERRADA', 'No hay una caja abierta');
    if (s < 0) {
      const disp = resumenCaja(db, caja.id).efectivoEsperado;
      if (importe > disp) throw err.conflicto('SALDO_INSUFICIENTE', `El importe supera el efectivo disponible en caja`);
    }
    const r = db.prepare('INSERT INTO movimientos_caja (caja_id, tipo, concepto, importe, usuario_id, fecha) VALUES (?,?,?,?,?,?)')
      .run(caja.id, tipo, concepto.trim().slice(0, 200), s * importe, usuario.id, ahora());
    auditar(db, { usuario, ip, accion: 'MOVIMIENTO_CAJA', entidad: 'movimiento', entidadId: r.lastInsertRowid, detalle: { caja: caja.id, tipo, importe: s * importe, concepto } });
    return detalleCaja(db, caja.id);
  });
}

export function pendientesCierre(db, cajaId) {
  const dentro = db.prepare("SELECT COUNT(*) AS grupos, COALESCE(SUM(cantidad),0) AS personas FROM visitas WHERE estado='DENTRO'").get();
  const transf = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(importe),0) AS total FROM ordenes WHERE caja_id = ? AND estado = 'PENDIENTE'").get(cajaId);
  const avisos = [];
  if (dentro.grupos > 0) avisos.push({ codigo: 'PERSONAS_DENTRO', mensaje: `Hay ${dentro.grupos} ingreso(s) activo(s) (${dentro.personas} persona/s) sin egreso registrado.` });
  if (transf.n > 0) avisos.push({ codigo: 'TRANSFERENCIAS_PENDIENTES', mensaje: `Hay ${transf.n} transferencia(s) sin verificar en esta caja.` });
  return avisos;
}

export function cerrarCaja(db, { declarado, observaciones, forzar }, usuario, ip) {
  const cfg = leerConfig(db);
  if (!Number.isInteger(declarado) || declarado < 0) throw err.validacion('Ingrese el efectivo contado (0 o mayor)');
  return tx(db, () => {
    const caja = cajaActual(db, usuario, cfg);
    if (!caja) throw err.conflicto('CAJA_CERRADA', 'No hay una caja abierta para cerrar');
    const avisos = pendientesCierre(db, caja.id);
    if (avisos.length) {
      if (!forzar) throw err.conflicto('PENDIENTES', 'Hay operaciones pendientes', { avisos, requiereAdmin: cfg.cierre_pendientes_solo_admin });
      if (cfg.cierre_pendientes_solo_admin && usuario.rol !== 'admin')
        throw err.prohibido('Hay operaciones pendientes: solo un administrador puede cerrar la caja en esta situación.');
    }
    const resumen = resumenCaja(db, caja.id);
    resumen.avisosAlCierre = avisos;
    const dif = declarado - resumen.efectivoEsperado;
    db.prepare(`UPDATE cajas SET estado='CERRADA', cierre=?, usuario_cierre=?, efectivo_esperado=?, efectivo_declarado=?, diferencia=?, resumen_json=?, observaciones=? WHERE id=? AND estado='ABIERTA'`)
      .run(ahora(), usuario.id, resumen.efectivoEsperado, declarado, dif, JSON.stringify(resumen), (observaciones || '').toString().slice(0, 500) || null, caja.id);
    auditar(db, { usuario, ip, accion: 'CAJA_CERRADA', entidad: 'caja', entidadId: caja.id, detalle: { esperado: resumen.efectivoEsperado, declarado, diferencia: dif, avisos: avisos.map((a) => a.codigo) } });
    return detalleCaja(db, caja.id);
  });
}

export function historialCajas(db, { limite = 50, offset = 0 } = {}) {
  const rows = db.prepare(`${SQL_CAJA} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(limite, offset).map(mapCaja);
  const total = db.prepare('SELECT COUNT(*) AS n FROM cajas').get().n;
  return { rows, total };
}
