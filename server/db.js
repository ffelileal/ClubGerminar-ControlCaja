import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','operador')),
  activo INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_pass INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creado TEXT NOT NULL,
  expira TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY,
  dni TEXT NOT NULL UNIQUE,
  nombre TEXT,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visitas (
  id INTEGER PRIMARY KEY,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  cantidad INTEGER NOT NULL CHECK (cantidad >= 1),
  ingreso TEXT NOT NULL,
  egreso TEXT,
  estado TEXT NOT NULL CHECK (estado IN ('DENTRO','FINALIZADA','ANULADA')),
  operador_ingreso INTEGER REFERENCES usuarios(id),
  operador_egreso INTEGER REFERENCES usuarios(id),
  motivo_anulacion TEXT,
  idem_key TEXT UNIQUE
);
-- Garantía: una persona no puede tener dos ingresos activos
CREATE UNIQUE INDEX IF NOT EXISTS ux_visita_activa ON visitas(persona_id) WHERE estado = 'DENTRO';
CREATE INDEX IF NOT EXISTS ix_visitas_ingreso ON visitas(ingreso);
CREATE INDEX IF NOT EXISTS ix_visitas_estado ON visitas(estado);

CREATE TABLE IF NOT EXISTS visita_correcciones (
  id INTEGER PRIMARY KEY,
  visita_id INTEGER NOT NULL REFERENCES visitas(id),
  campo TEXT NOT NULL,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  motivo TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha TEXT NOT NULL
);

-- Tarifa por tramos: el precio aplicable es el del tramo con mayor "desde" <= cantidad.
-- El último tramo representa "N o más".
CREATE TABLE IF NOT EXISTS tarifas (
  id INTEGER PRIMARY KEY,
  desde INTEGER NOT NULL UNIQUE CHECK (desde >= 1),
  precio INTEGER NOT NULL CHECK (precio >= 0)
);

CREATE TABLE IF NOT EXISTS cajas (
  id INTEGER PRIMARY KEY,
  estado TEXT NOT NULL CHECK (estado IN ('ABIERTA','CERRADA')),
  apertura TEXT NOT NULL,
  usuario_apertura INTEGER NOT NULL REFERENCES usuarios(id),
  saldo_inicial INTEGER NOT NULL CHECK (saldo_inicial >= 0),
  cierre TEXT,
  usuario_cierre INTEGER REFERENCES usuarios(id),
  efectivo_esperado INTEGER,
  efectivo_declarado INTEGER,
  diferencia INTEGER,
  resumen_json TEXT,
  observaciones TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_caja_abierta_usuario ON cajas(usuario_apertura) WHERE estado = 'ABIERTA';

CREATE TABLE IF NOT EXISTS ordenes (
  numero INTEGER PRIMARY KEY,
  visita_id INTEGER NOT NULL REFERENCES visitas(id),
  caja_id INTEGER NOT NULL REFERENCES cajas(id),
  cantidad INTEGER NOT NULL,
  importe INTEGER NOT NULL CHECK (importe >= 0),
  medio TEXT NOT NULL CHECK (medio IN ('EFECTIVO','TRANSFERENCIA')),
  estado TEXT NOT NULL CHECK (estado IN ('PAGADO','PENDIENTE','ANULADA')),
  referencia TEXT,
  recibido INTEGER,
  vuelto INTEGER,
  operador_id INTEGER NOT NULL REFERENCES usuarios(id),
  verificado_por INTEGER REFERENCES usuarios(id),
  verificado_en TEXT,
  anulada_por INTEGER REFERENCES usuarios(id),
  anulada_en TEXT,
  motivo_anulacion TEXT,
  fecha TEXT NOT NULL,
  idem_key TEXT UNIQUE
);
-- Garantía: una visita no puede cobrarse dos veces (salvo que la orden anterior esté anulada)
CREATE UNIQUE INDEX IF NOT EXISTS ux_orden_visita ON ordenes(visita_id) WHERE estado <> 'ANULADA';
CREATE INDEX IF NOT EXISTS ix_ordenes_fecha ON ordenes(fecha);
CREATE INDEX IF NOT EXISTS ix_ordenes_caja ON ordenes(caja_id);

-- importe con signo: positivo suma efectivo físico, negativo resta.
CREATE TABLE IF NOT EXISTS movimientos_caja (
  id INTEGER PRIMARY KEY,
  caja_id INTEGER NOT NULL REFERENCES cajas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('COBRO','INGRESO','RETIRO','GASTO','AJUSTE','ANULACION')),
  concepto TEXT NOT NULL,
  importe INTEGER NOT NULL,
  orden_numero INTEGER REFERENCES ordenes(numero),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mov_caja ON movimientos_caja(caja_id);

CREATE TABLE IF NOT EXISTS comprobantes (
  numero INTEGER PRIMARY KEY,
  orden_numero INTEGER NOT NULL UNIQUE REFERENCES ordenes(numero),
  visita_id INTEGER NOT NULL REFERENCES visitas(id),
  dni TEXT NOT NULL,
  nombre TEXT,
  data_json TEXT NOT NULL,
  archivo TEXT,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  accion TEXT NOT NULL,
  entidad TEXT,
  entidad_id TEXT,
  detalle TEXT,
  ip TEXT,
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_auditoria_fecha ON auditoria(fecha);

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

export const CONFIG_DEFAULTS = {
  establecimiento_nombre: 'Establecimiento',
  establecimiento_direccion: '',
  establecimiento_telefono: '',
  establecimiento_cuit: '',
  comprobante_pie: 'Comprobante interno - No válido como factura',
  comprobante_formato: '80mm', // 80mm | 58mm | A4
  dni_min: '7',
  dni_max: '8',
  dni_alfanumerico: '0',
  guardar_nombre: '0',
  ocultar_dni_operador: '1',
  caja_unica: '1',
  ingreso_requiere_caja: '0',
  cierre_pendientes_solo_admin: '1',
  operador_puede_retirar: '1',
  anulacion_operador_minutos: '10',
  max_personas: '50',
  botones_cantidad: '6',
  backup_retencion: '30',
};

export function abrirDB(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);

  const asegurarColumnas = (tabla, columnas) => {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabla})`).all().map((r) => r.name));
    for (const [nombre, definicion] of Object.entries(columnas)) {
      if (!existentes.has(nombre)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${nombre} ${definicion}`);
    }
  };
  asegurarColumnas('personas', {
    apellido: 'TEXT',
    sexo: 'TEXT',
    fecha_nacimiento: 'TEXT',
  });
  asegurarColumnas('tarifas', {
    nombre: 'TEXT',
    descripcion: 'TEXT',
    cantidad: 'INTEGER',
    activa: 'INTEGER NOT NULL DEFAULT 1',
    creada: 'TEXT',
    personalizada: 'INTEGER NOT NULL DEFAULT 0',
  });
  asegurarColumnas('visitas', {
    tarifa_id: 'INTEGER',
    tarifa_nombre: 'TEXT',
    tarifa_cantidad: 'INTEGER',
    importe_snapshot: 'INTEGER',
    medio_pago: 'TEXT',
    estado_pago: 'TEXT',
  });
  asegurarColumnas('ordenes', {
    tarifa_id: 'INTEGER',
    tarifa_nombre: 'TEXT',
    tarifa_cantidad: 'INTEGER',
    nombre_titular: 'TEXT',
  });
  db.exec(`UPDATE tarifas SET nombre = COALESCE(nombre, 'Tarifa ' || desde || ' persona/s'),
    descripcion = COALESCE(descripcion, ''),
    cantidad = COALESCE(cantidad, desde),
    creada = COALESCE(creada, datetime('now', 'localtime'))
    WHERE nombre IS NULL OR descripcion IS NULL OR cantidad IS NULL OR creada IS NULL`);
  const ins = db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)');
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) ins.run(k, v);
  return db;
}

/**
 * Ejecuta fn dentro de una transacción IMMEDIATE (serializa escrituras).
 * Si fn lanza, se hace ROLLBACK y se propaga el error.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}
