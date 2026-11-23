import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { AppError, err } from './util.js';
import { enmascarar } from '../shared/dni.js';
import * as auth from './services/auth.js';
import { leerConfig, guardarConfig } from './services/config.js';
import * as visitas from './services/visitas.js';
import * as tarifas from './services/tarifas.js';
import * as cobros from './services/cobros.js';
import * as caja from './services/caja.js';
import * as rep from './services/reportes.js';
import { generarComprobante, rutaComprobante } from './services/comprobantes.js';

const COOKIE = 'sid';

function leerCookie(req, nombre) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const parte of h.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

const int = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const paginacion = (q, max = 200) => ({
  limite: Math.min(Math.max(parseInt(q.limite) || 50, 1), max),
  offset: Math.max(parseInt(q.offset) || 0, 0),
});

export function crearApp(db, { backupDir, clientDir, secureCookie = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '100kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const api = express.Router();
  const h = (fn) => (req, res, next) => {
    try {
      const r = fn(req, res);
      if (r !== undefined && !res.headersSent) res.json(r);
    } catch (e) {
      next(e);
    }
  };
  const ip = (req) => req.socket.remoteAddress;

  // Protección CSRF: toda escritura debe venir de nuestro frontend (cabecera personalizada + JSON)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-Requested-With') !== 'control-caja')
      return next(err.prohibido('Solicitud rechazada'));
    next();
  });

  api.get('/health', h(() => ({ ok: true, hora: new Date().toISOString() })));
  api.get('/auth/branding', h(() => {
    const cfg = leerConfig(db);
    return { establecimiento: cfg.establecimiento_nombre, direccion: cfg.establecimiento_direccion };
  }));

  api.post('/auth/login', h((req, res) => {
    const { token, usuario } = auth.login(db, req.body?.usuario, req.body?.password, ip(req));
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/', maxAge: 12 * 3600 * 1000 });
    const cfg = leerConfig(db);
    return {
      usuario,
      config: {
        establecimiento: cfg.establecimiento_nombre,
        direccion: cfg.establecimiento_direccion,
      },
    };
  }));

  // Autenticación para el resto
  api.use((req, res, next) => {
    const token = leerCookie(req, COOKIE);
    const u = auth.usuarioDesdeToken(db, token);
    if (!u) return next(err.noAuth());
    req.usuario = u;
    req.token = token;
    next();
  });
  const soloAdmin = (req, res, next) => (req.usuario.rol === 'admin' ? next() : next(err.prohibido()));
  // Si debe cambiar la contraseña, solo puede hacer eso
  api.use((req, res, next) => {
    if (req.usuario.debeCambiarPass && !['/auth/me', '/auth/password', '/auth/logout'].includes(req.path))
      return next(err.conflicto('DEBE_CAMBIAR_PASS', 'Debe cambiar su contraseña antes de continuar'));
    next();
  });

  const verDni = (req) => req.usuario.rol === 'admin' || !leerConfig(db).ocultar_dni_operador;
  const mascara = (req, rows) => (verDni(req) ? rows : rows.map((r) => ({ ...r, dni: enmascarar(r.dni) })));

  api.get('/auth/me', h((req) => {
    const cfg = leerConfig(db);
    return {
      usuario: req.usuario,
      config: {
        establecimiento: cfg.establecimiento_nombre,
        direccion: cfg.establecimiento_direccion,
        maxPersonas: cfg.max_personas,
        botonesCantidad: cfg.botones_cantidad,
        dni: { min: cfg.dni_min, max: cfg.dni_max, alfanumerico: cfg.dni_alfanumerico },
        guardarNombre: cfg.guardar_nombre,
        operadorPuedeRetirar: cfg.operador_puede_retirar,
        comprobanteFormato: cfg.comprobante_formato,
      },
    };
  }));
  api.post('/auth/logout', h((req, res) => {
    auth.logout(db, req.token, req.usuario, ip(req));
    res.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }));
  api.post('/auth/password', h((req) => {
    auth.cambiarPassword(db, req.usuario, req.body?.actual, req.body?.nueva, ip(req));
    return { ok: true };
  }));

  // ---- Operación ----
  api.post('/operacion/escaneo', h((req) => visitas.procesarEscaneo(db, req.body?.lectura, req.usuario)));
  api.post('/visitas', h((req) => cobros.registrarIngresoPagado(db, {
    dni: req.body?.dni,
    nombre: req.body?.nombre,
    apellido: req.body?.apellido,
    sexo: req.body?.sexo,
    fechaNacimiento: req.body?.fechaNacimiento,
    cantidad: req.body?.cantidad,
    tarifaId: req.body?.tarifaId,
    medio: req.body?.medio,
    recibido: int(req.body?.recibido),
    referencia: req.body?.referencia,
    verificada: req.body?.verificada === true,
    idemKey: req.body?.idemKey,
  }, req.usuario, ip(req))));
  api.get('/visitas/activas', h((req) => mascara(req, visitas.listarActivas(db))));
  api.get('/visitas/:id', h((req) => {
    const v = visitas.obtenerVisita(db, Number(req.params.id));
    return verDni(req) ? v : { ...v, dni: enmascarar(v.dni) };
  }));
  api.patch('/visitas/:id', h((req) => visitas.corregirVisita(db, Number(req.params.id), req.body || {}, req.usuario, ip(req))));
  api.post('/visitas/:id/anular', h((req) => visitas.anularVisita(db, Number(req.params.id), req.body?.motivo, req.usuario, ip(req))));
  api.post('/visitas/:id/egresar', h((req) => cobros.registrarEgreso(db, Number(req.params.id), req.usuario, ip(req))));
  api.get('/visitas/:id/tarifa', h((req) => {
    const v = visitas.obtenerVisita(db, Number(req.params.id));
    return tarifas.calcularTarifa(db, v.cantidad);
  }));

  api.post('/cobros', h((req) => cobros.cobrar(db, {
    visitaId: Number(req.body?.visitaId),
    medio: req.body?.medio,
    recibido: int(req.body?.recibido),
    referencia: req.body?.referencia,
    verificada: req.body?.verificada === true,
    idemKey: req.body?.idemKey,
  }, req.usuario, ip(req))));
  api.get('/ordenes/:numero', h((req) => {
    const o = cobros.obtenerOrden(db, Number(req.params.numero));
    const cfg = leerConfig(db);
    return {
      ...(verDni(req) ? o : { ...o, dni: enmascarar(o.dni) }),
      dniComprobante: enmascarar(o.dni),
      establecimiento: {
        nombre: cfg.establecimiento_nombre, direccion: cfg.establecimiento_direccion,
        telefono: cfg.establecimiento_telefono, cuit: cfg.establecimiento_cuit,
        pie: cfg.comprobante_pie, formato: cfg.comprobante_formato,
      },
    };
  }));
  api.post('/ordenes/:numero/verificar', h((req) => cobros.verificarTransferencia(db, Number(req.params.numero), req.body?.referencia, req.usuario, ip(req))));
  api.post('/ordenes/:numero/anular', soloAdmin, h((req) => cobros.anularOrden(db, Number(req.params.numero), req.body?.motivo, req.usuario, ip(req))));
  api.get('/comprobantes/:numero.pdf', async (req, res, next) => {
    try {
      const dir = backupDir ? path.join(path.dirname(backupDir), 'comprobantes') : path.resolve('data', 'comprobantes');
      const numero = Number(req.params.numero);
      await generarComprobante(db, numero, dir, req.usuario, ip(req));
      const archivo = path.resolve(rutaComprobante(dir, numero));
      const nombre = `comprobante-${String(numero).padStart(6, '0')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', req.query.descargar === '1'
        ? `attachment; filename="${nombre}"`
        : `inline; filename="${nombre}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).send(fs.readFileSync(archivo));
    } catch (e) { next(e); }
  });

  // ---- Tarifas ----
  api.get('/tarifas', h(() => tarifas.listarTarifas(db)));
  api.put('/tarifas', soloAdmin, h((req) => tarifas.guardarTarifas(db, req.body?.tramos, req.usuario, ip(req))));
  api.get('/tarifas/compatibles/:cantidad', h((req) => tarifas.listarCompatibles(db, Number(req.params.cantidad))));
  api.post('/tarifas', soloAdmin, h((req) => tarifas.crearTarifa(db, req.body || {}, req.usuario, ip(req))));
  api.patch('/tarifas/:id', soloAdmin, h((req) => tarifas.actualizarTarifa(db, tarifas.resolverTarifaId(db, req.params.id), req.body || {}, req.usuario, ip(req))));
  api.delete('/tarifas/:id', soloAdmin, h((req) => tarifas.eliminarTarifa(db, tarifas.resolverTarifaId(db, req.params.id), req.usuario, ip(req))));

  // ---- Caja ----
  api.get('/caja/actual', h((req) => ({ caja: caja.estadoCaja(db, req.usuario) })));
  api.post('/caja/abrir', h((req) => caja.abrirCaja(db, int(req.body?.saldoInicial), req.usuario, ip(req))));
  api.post('/caja/movimientos', h((req) => caja.registrarMovimiento(db, {
    tipo: req.body?.tipo, concepto: req.body?.concepto, importe: int(req.body?.importe), signo: int(req.body?.signo),
  }, req.usuario, ip(req))));
  api.get('/caja/pendientes', h((req) => {
    const c = caja.cajaActual(db, req.usuario);
    return { avisos: c ? caja.pendientesCierre(db, c.id) : [] };
  }));
  api.post('/caja/cerrar', h((req) => caja.cerrarCaja(db, {
    declarado: int(req.body?.declarado), observaciones: req.body?.observaciones, forzar: req.body?.forzar === true,
  }, req.usuario, ip(req))));
  api.get('/caja/historial', h((req) => caja.historialCajas(db, paginacion(req.query))));
  api.get('/caja/:id', h((req) => caja.detalleCaja(db, Number(req.params.id))));

  // ---- Dashboard ----
  api.get('/dashboard', h((req) => rep.dashboard(db, [7, 30, 90].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30)));

  // ---- Historial + CSV ----
  const filtros = (q) => ({ desde: q.desde, hasta: q.hasta, dni: q.dni, estado: q.estado, medio: q.medio, operador: q.operador, numero: q.numero, q: q.q, caja: q.caja });
  const fh = (s) => s || '';
  api.get('/historial/visitas', h((req, res) => {
    if (req.query.formato === 'csv') {
      const { rows } = rep.historialVisitas(db, filtros(req.query), { limite: 100000, offset: 0 });
      const csv = rep.aCSV([
        { titulo: 'ID', valor: (r) => r.id },
        { titulo: 'DNI', valor: (r) => r.dni },
        { titulo: 'Personas', valor: (r) => r.cantidad },
        { titulo: 'Ingreso', valor: (r) => r.ingreso },
        { titulo: 'Egreso', valor: (r) => fh(r.egreso) },
        { titulo: 'Estado', valor: (r) => r.estado },
        { titulo: 'Orden', valor: (r) => r.ordenNumero ?? '' },
        { titulo: 'Importe', valor: (r) => rep.montoCSV(r.importe) },
        { titulo: 'Medio de pago', valor: (r) => r.medio ?? '' },
        { titulo: 'Estado pago', valor: (r) => r.estadoPago ?? '' },
        { titulo: 'Operador ingreso', valor: (r) => r.operadorIngreso ?? '' },
        { titulo: 'Operador egreso', valor: (r) => r.operadorEgreso ?? '' },
      ], mascara(req, rows));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ingresos-egresos.csv"`);
      res.send(csv);
      return;
    }
    const r = rep.historialVisitas(db, filtros(req.query), paginacion(req.query));
    return { ...r, rows: mascara(req, r.rows) };
  }));
  api.get('/historial/ordenes', h((req, res) => {
    if (req.query.formato === 'csv') {
      const { rows } = rep.historialOrdenes(db, filtros(req.query), { limite: 100000, offset: 0 });
      const csv = rep.aCSV([
        { titulo: 'Orden', valor: (r) => r.numero },
        { titulo: 'Fecha', valor: (r) => r.fecha },
        { titulo: 'DNI', valor: (r) => r.dni },
        { titulo: 'Personas', valor: (r) => r.cantidad },
        { titulo: 'Ingreso', valor: (r) => r.ingreso },
        { titulo: 'Egreso', valor: (r) => fh(r.egreso) },
        { titulo: 'Importe', valor: (r) => rep.montoCSV(r.importe) },
        { titulo: 'Medio de pago', valor: (r) => r.medio },
        { titulo: 'Referencia', valor: (r) => r.referencia ?? '' },
        { titulo: 'Estado', valor: (r) => r.estado },
        { titulo: 'Caja', valor: (r) => r.cajaId },
        { titulo: 'Operador', valor: (r) => r.operador },
      ], mascara(req, rows));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ordenes.csv"`);
      res.send(csv);
      return;
    }
    const r = rep.historialOrdenes(db, filtros(req.query), paginacion(req.query));
    return { ...r, rows: mascara(req, r.rows) };
  }));
  api.get('/operadores', h(() => db.prepare('SELECT id, nombre FROM usuarios ORDER BY nombre').all()));

  // ---- Administración ----
  api.get('/admin/usuarios', soloAdmin, h(() => auth.listarUsuarios(db)));
  api.post('/admin/usuarios', soloAdmin, h((req) => auth.crearUsuario(db, req.body || {}, req.usuario, ip(req))));
  api.patch('/admin/usuarios/:id', soloAdmin, h((req) => auth.actualizarUsuario(db, Number(req.params.id), req.body || {}, req.usuario, ip(req))));
  api.get('/admin/config', soloAdmin, h(() => leerConfig(db)));
  api.put('/admin/config', soloAdmin, h((req) => guardarConfig(db, req.body || {}, req.usuario, ip(req))));
  api.get('/admin/auditoria', soloAdmin, h((req) => rep.listarAuditoria(db, { desde: req.query.desde, hasta: req.query.hasta, usuario: req.query.usuario, accion: req.query.accion }, paginacion(req.query, 500))));
  api.get('/admin/backups', soloAdmin, h(() => rep.listarBackups(backupDir)));
  api.post('/admin/backups', soloAdmin, h((req) => rep.crearBackup(db, backupDir, leerConfig(db).backup_retencion, req.usuario, ip(req))));
  api.get('/admin/backups/:archivo', soloAdmin, (req, res, next) => {
    try {
      res.download(rep.rutaBackup(backupDir, req.params.archivo));
    } catch (e) { next(e); }
  });

  api.use((req, res, next) => next(err.noExiste('Ruta inexistente')));

  app.use('/api', api);

  // Frontend compilado
  if (clientDir && fs.existsSync(clientDir)) {
    const indexHtml = path.resolve(clientDir, 'index.html');
    app.get('/', (req, res) => res.type('html').send(fs.readFileSync(indexHtml)));
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.type('html').send(fs.readFileSync(indexHtml)));
  }

  // Manejo centralizado de errores
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (e instanceof AppError) return res.status(e.status).json({ error: e.codigo, mensaje: e.message, ...(e.extra || {}) });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'VALIDACION', mensaje: 'Datos inválidos' });
    if (String(e?.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'DUPLICADO', mensaje: 'La operación ya fue registrada (registro duplicado)' });
    }
    console.error('[ERROR]', e);
    res.status(500).json({ error: 'INTERNO', mensaje: 'Error interno. La operación no se completó; intente nuevamente.' });
  });

  return app;
}
