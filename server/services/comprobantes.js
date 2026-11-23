import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { ahora, err } from '../util.js';
import { auditar, leerConfig } from './config.js';

export function rutaComprobante(dir, numero) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `comprobante-${String(numero).padStart(6, '0')}.pdf`);
}

export async function generarComprobante(db, numero, dir, usuario = null, ip = null) {
  const o = db.prepare(`
    SELECT o.*, p.dni, p.nombre AS persona_nombre, p.apellido, v.ingreso,
           u.nombre AS operador_nombre
    FROM ordenes o
    JOIN visitas v ON v.id = o.visita_id
    JOIN personas p ON p.id = v.persona_id
    JOIN usuarios u ON u.id = o.operador_id
    WHERE o.numero = ?`).get(numero);
  if (!o) throw err.noExiste('Comprobante inexistente');
  const cfg = leerConfig(db);
  const destino = rutaComprobante(dir, numero);
  if (fs.existsSync(destino)) {
    const data = {
      numero,
      fecha: o.fecha,
      ingreso: o.ingreso,
      dni: o.dni,
      titular: [o.apellido, o.persona_nombre].filter(Boolean).join(', ') || o.nombre_titular || 'Titular',
      cantidad: o.cantidad,
      tarifa: o.tarifa_nombre,
      importe: o.importe,
      medio: o.medio,
      estado: o.estado,
      operador: o.operador_nombre,
    };
    db.prepare(`INSERT OR IGNORE INTO comprobantes
      (numero, orden_numero, visita_id, dni, nombre, data_json, archivo, creado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(numero, numero, o.visita_id, o.dni, data.titular, JSON.stringify(data), destino, ahora());
    return destino;
  }
  const dniCompleto = o.dni;
  const titular = [o.apellido, o.persona_nombre].filter(Boolean).join(', ') || o.nombre_titular || 'Titular';
  const monto = o.importe / 100;
  const qr = await QRCode.toDataURL(`CONTROL-COMPROBANTE:${numero}`);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
      Title: `Comprobante de ingreso ${String(numero).padStart(6, '0')}`,
      Author: cfg.establecimiento_nombre,
      Subject: 'Comprobante interno de ingreso y pago',
    } });
    const stream = fs.createWriteStream(destino);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    doc.rect(50, 45, 495, 85).fill('#134e4a');
    const logoPdf = path.resolve('client/public/club-germinar.png');
    if (fs.existsSync(logoPdf)) doc.image(logoPdf, 65, 58, { width: 58, height: 58 });
    doc.fillColor('#ffffff').fontSize(20).text(cfg.establecimiento_nombre, 135, 65, { width: 295 });
    if (cfg.establecimiento_direccion) doc.fontSize(10).text(cfg.establecimiento_direccion, 135, 92, { width: 295 });
    doc.fontSize(12).text('COMPROBANTE DE INGRESO', 70, 92);
    doc.fontSize(11).text(`N° ${String(numero).padStart(6, '0')}`, 410, 68, { align: 'right', width: 115 });
    doc.moveDown();

    doc.fillColor('#1b2320').fontSize(11);
    doc.text(`Fecha y hora: ${o.fecha}`);
    doc.moveDown(0.7);

    doc.fontSize(16).text('Datos del ingreso', 50, 155);
    doc.fontSize(11);
    const filas = [
      ['Titular', titular],
      ['DNI', dniCompleto],
      ['Cantidad de personas', String(o.cantidad)],
      ['Tarifa aplicada', o.tarifa_nombre || 'Tarifa'],
      ['Ingreso', o.ingreso],
      ['Operador', o.operador_nombre],
    ];
    let y = 185;
    for (const [clave, valor] of filas) {
      doc.fillColor('#6b756f').text(clave.toUpperCase(), 50, y, { width: 150 });
      doc.fillColor('#1b2320').text(String(valor), 205, y, { width: 270 });
      y += 24;
    }

    doc.rect(50, y + 10, 495, 88).fill('#f3f4f1');
    doc.fillColor('#1b2320').fontSize(13).text('DETALLE DEL PAGO', 70, y + 25);
    doc.fontSize(11).text(`Importe abonado: $ ${monto.toFixed(2).replace('.', ',')}`, 70, y + 50);
    doc.text(`Medio: ${o.medio === 'EFECTIVO' ? 'EFECTIVO' : 'TRANSFERENCIA'}`, 280, y + 50);
    doc.text(`Estado: ${o.estado === 'PAGADO' ? 'PAGADO' : 'PENDIENTE DE VERIFICACION'}`, 70, y + 70);
    if (o.referencia) doc.text(`Referencia: ${o.referencia}`, 280, y + 70);

    doc.image(qr, 410, 420, { width: 95 });
    doc.fillColor('#6b756f').fontSize(9).text('Identificador del comprobante', 395, 520, { align: 'center', width: 125 });
    doc.moveDown(8);
    doc.fillColor('#1b2320').fontSize(9).text(cfg.comprobante_pie, 50, 720, { align: 'center', width: 495 });
    doc.end();
  });

  const data = {
    numero, fecha: o.fecha, ingreso: o.ingreso, dni: dniCompleto, titular,
    cantidad: o.cantidad, tarifa: o.tarifa_nombre, importe: o.importe,
    medio: o.medio, estado: o.estado, operador: o.operador_nombre,
  };
  db.prepare(`INSERT INTO comprobantes (numero, orden_numero, visita_id, dni, nombre, data_json, archivo, creado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(numero) DO UPDATE SET archivo=excluded.archivo`)
    .run(numero, numero, o.visita_id, dniCompleto, titular, JSON.stringify(data), destino, ahora());
  if (usuario) auditar(db, { usuario, ip, accion: 'COMPROBANTE_GENERADO', entidad: 'comprobante', entidadId: numero,
    detalle: { archivo: path.basename(destino) } });
  return destino;
}
