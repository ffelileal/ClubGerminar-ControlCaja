import crypto from 'node:crypto';
import { ahora, err } from '../util.js';
import { auditar } from './config.js';
import { tx } from '../db.js';

const SESION_HORAS = 12;

export function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verificarPassword(pass, almacenado) {
  const [alg, saltHex, hashHex] = String(almacenado).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calc = crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), esperado.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(esperado, calc);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function validarPasswordNueva(p) {
  if (typeof p !== 'string' || p.length < 6) throw err.validacion('La contraseña debe tener al menos 6 caracteres');
  if (p.length > 200) throw err.validacion('Contraseña demasiado larga');
}

export function asegurarAdminInicial(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
  if (n === 0) {
    db.prepare('INSERT INTO usuarios (usuario, nombre, hash, rol, activo, debe_cambiar_pass, creado) VALUES (?,?,?,?,1,1,?)')
      .run('admin', 'Administrador', hashPassword('admin'), 'admin', ahora());
    return true;
  }
  return false;
}

// Limitador de intentos de login en memoria (por usuario+ip)
const intentos = new Map();
function chequearIntentos(clave) {
  const r = intentos.get(clave);
  if (r && r.bloqueadoHasta > Date.now()) {
    const seg = Math.ceil((r.bloqueadoHasta - Date.now()) / 1000);
    throw err.conflicto('BLOQUEADO', `Demasiados intentos fallidos. Espere ${seg} segundos.`);
  }
}
function registrarFallo(clave) {
  const r = intentos.get(clave) || { n: 0, bloqueadoHasta: 0 };
  r.n += 1;
  if (r.n >= 5) { r.bloqueadoHasta = Date.now() + 5 * 60 * 1000; r.n = 0; }
  intentos.set(clave, r);
}

export function login(db, usuario, pass, ip) {
  if (!usuario || !pass) throw err.validacion('Ingrese usuario y contraseña');
  const clave = `${String(usuario).toLowerCase()}|${ip}`;
  chequearIntentos(clave);
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario));
  if (!u || !u.activo || !verificarPassword(String(pass), u.hash)) {
    registrarFallo(clave);
    auditar(db, { usuarioId: u?.id, ip, accion: 'LOGIN_FALLIDO', entidad: 'usuario', detalle: { usuario: String(usuario).slice(0, 50) } });
    throw err.noAuth('Usuario o contraseña incorrectos');
  }
  intentos.delete(clave);
  const token = crypto.randomBytes(32).toString('hex');
  const expira = ahora(new Date(Date.now() + SESION_HORAS * 3600 * 1000));
  db.prepare('INSERT INTO sesiones (token_hash, usuario_id, creado, expira) VALUES (?,?,?,?)').run(sha(token), u.id, ahora(), expira);
  db.prepare('DELETE FROM sesiones WHERE expira < ?').run(ahora());
  auditar(db, { usuarioId: u.id, ip, accion: 'LOGIN', entidad: 'usuario', entidadId: u.id });
  return { token, usuario: publico(u) };
}

export function usuarioDesdeToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.expira FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row || row.expira < ahora() || !row.activo) return null;
  // Expiración deslizante
  db.prepare('UPDATE sesiones SET expira = ? WHERE token_hash = ?').run(ahora(new Date(Date.now() + SESION_HORAS * 3600 * 1000)), sha(token));
  return publico(row);
}

export function logout(db, token, usuario, ip) {
  if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(sha(token));
  if (usuario) auditar(db, { usuario, ip, accion: 'LOGOUT', entidad: 'usuario', entidadId: usuario.id });
}

export function cambiarPassword(db, usuario, actual, nueva, ip) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
  if (!verificarPassword(String(actual || ''), u.hash)) throw err.validacion('La contraseña actual es incorrecta');
  validarPasswordNueva(nueva);
  if (actual === nueva) throw err.validacion('La nueva contraseña debe ser distinta a la actual');
  db.prepare('UPDATE usuarios SET hash = ?, debe_cambiar_pass = 0 WHERE id = ?').run(hashPassword(nueva), u.id);
  auditar(db, { usuario, ip, accion: 'PASSWORD_CAMBIADA', entidad: 'usuario', entidadId: u.id });
}

export function publico(u) {
  return { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: !!u.activo, debeCambiarPass: !!u.debe_cambiar_pass, creado: u.creado };
}

// ---- Administración de usuarios ----
export function listarUsuarios(db) {
  return db.prepare('SELECT * FROM usuarios ORDER BY activo DESC, nombre').all().map(publico);
}

function validarDatosUsuario({ usuario, nombre, rol }, parcial = false) {
  if (!parcial || usuario !== undefined) {
    if (typeof usuario !== 'string' || !/^[a-zA-Z0-9._-]{3,30}$/.test(usuario))
      throw err.validacion('El usuario debe tener 3 a 30 caracteres (letras, números, punto, guion)');
  }
  if (!parcial || nombre !== undefined) {
    if (typeof nombre !== 'string' || nombre.trim().length < 2 || nombre.length > 80) throw err.validacion('Ingrese un nombre válido');
  }
  if (!parcial || rol !== undefined) {
    if (!['admin', 'operador'].includes(rol)) throw err.validacion('Rol inválido');
  }
}

export function crearUsuario(db, datos, admin, ip) {
  validarDatosUsuario(datos);
  validarPasswordNueva(datos.password);
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(datos.usuario)) throw err.conflicto('USUARIO_EXISTE', 'Ya existe un usuario con ese nombre');
    const r = db.prepare('INSERT INTO usuarios (usuario, nombre, hash, rol, activo, debe_cambiar_pass, creado) VALUES (?,?,?,?,1,1,?)')
      .run(datos.usuario, datos.nombre.trim(), hashPassword(datos.password), datos.rol, ahora());
    auditar(db, { usuario: admin, ip, accion: 'USUARIO_CREADO', entidad: 'usuario', entidadId: r.lastInsertRowid, detalle: { usuario: datos.usuario, rol: datos.rol } });
    return publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid));
  });
}

export function actualizarUsuario(db, id, datos, admin, ip) {
  validarDatosUsuario(datos, true);
  return tx(db, () => {
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!u) throw err.noExiste('Usuario inexistente');
    const nuevoRol = datos.rol ?? u.rol;
    const nuevoActivo = datos.activo === undefined ? !!u.activo : !!datos.activo;
    if (u.rol === 'admin' && u.activo && (nuevoRol !== 'admin' || !nuevoActivo)) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol='admin' AND activo=1").get().n;
      if (admins <= 1) throw err.conflicto('ULTIMO_ADMIN', 'Debe existir al menos un administrador activo');
    }
    const cambios = {};
    if (datos.nombre !== undefined && datos.nombre.trim() !== u.nombre) cambios.nombre = datos.nombre.trim();
    if (nuevoRol !== u.rol) cambios.rol = nuevoRol;
    if (nuevoActivo !== !!u.activo) cambios.activo = nuevoActivo ? 1 : 0;
    if (datos.password) {
      validarPasswordNueva(datos.password);
      cambios.hash = hashPassword(datos.password);
      cambios.debe_cambiar_pass = 1;
    }
    const claves = Object.keys(cambios);
    if (claves.length) {
      db.prepare(`UPDATE usuarios SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...claves.map((k) => cambios[k]), id);
      if (cambios.activo === 0 || cambios.hash || cambios.rol) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
      const det = { ...cambios };
      if (det.hash) { delete det.hash; det.password = 'restablecida'; }
      auditar(db, { usuario: admin, ip, accion: 'USUARIO_MODIFICADO', entidad: 'usuario', entidadId: id, detalle: det });
    }
    return publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id));
  });
}
