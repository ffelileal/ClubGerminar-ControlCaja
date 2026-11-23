import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirDB } from './db.js';
import { crearApp } from './app.js';
import { asegurarAdminInicial } from './services/auth.js';
import { crearBackup } from './services/reportes.js';
import { leerConfig } from './services/config.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(raiz, 'data');
const DB_FILE = path.join(DATA_DIR, 'control-caja.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const db = abrirDB(DB_FILE);
if (asegurarAdminInicial(db)) {
  console.log('Usuario inicial creado: admin / admin (se pedirá cambiar la contraseña al ingresar)');
}

function backupAutomatico() {
  try {
    const r = crearBackup(db, BACKUP_DIR, leerConfig(db).backup_retencion);
    console.log(`[backup] ${r.archivo}`);
  } catch (e) {
    console.error('[backup] error', e);
  }
}
backupAutomatico();
setInterval(backupAutomatico, 6 * 3600 * 1000).unref();

const app = crearApp(db, { backupDir: BACKUP_DIR, clientDir: path.join(raiz, 'dist') });
const server = app.listen(PORT, HOST, () => {
  console.log(`Control de Caja escuchando en http://localhost:${PORT}`);
});

function apagar() {
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
