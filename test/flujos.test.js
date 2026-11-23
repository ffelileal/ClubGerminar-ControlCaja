import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirDB } from '../server/db.js';
import { crearApp } from '../server/app.js';
import { asegurarAdminInicial } from '../server/services/auth.js';
import { generarComprobante } from '../server/services/comprobantes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function iniciar() {
  const db = abrirDB(':memory:');
  asegurarAdminInicial(db);
  const app = crearApp(db);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await login(base);
  return { db, server, base, cookie };
}

async function login(base) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'control-caja' },
    body: JSON.stringify({ usuario: 'admin', password: 'admin' }),
  });
  assert.equal(r.status, 200);
  await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'control-caja', cookie: r.headers.get('set-cookie').split(';')[0] },
    body: JSON.stringify({ actual: 'admin', nueva: 'admin123' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}

async function req(base, cookie, url, body) {
  const r = await fetch(`${base}/api${url}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'control-caja', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { status: r.status, data };
}

test('ingreso único y cobro idempotente', async (t) => {
  const ctx = await iniciar();
  t.after(() => ctx.server.close());

  await req(ctx.base, ctx.cookie, '/tarifas');
  await req(ctx.base, ctx.cookie, '/tarifas', undefined);

  let r = await req(ctx.base, ctx.cookie, '/caja/abrir', { saldoInicial: 100000 });
  assert.equal(r.status, 200);
  r = await req(ctx.base, ctx.cookie, '/tarifas');

  if (!r.data.length) {
    r = await req(ctx.base, ctx.cookie, '/tarifas', undefined);
  }
  await fetch(`${ctx.base}/api/tarifas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'control-caja', cookie: ctx.cookie },
    body: JSON.stringify({ tramos: [{ desde: 1, precio: 500 }, { desde: 2, precio: 1000 }, { desde: 4, precio: 1800 }] }),
  });

  r = await req(ctx.base, ctx.cookie, '/tarifas');
  const tarifaId = r.data.find((t) => t.cantidad === 2).id;
  r = await req(ctx.base, ctx.cookie, '/visitas', {
    dni: '12345678', nombre: 'Juan', apellido: 'Perez', cantidad: 2,
    tarifaId, medio: 'EFECTIVO', recibido: 2000, idemKey: 'ingreso-uno',
  });
  assert.equal(r.status, 200);
  const visitaId = r.data.visitaId;
  const numeroComprobante = r.data.numero;

  r = await req(ctx.base, ctx.cookie, '/visitas', {
    dni: '12345678', nombre: 'Juan', apellido: 'Perez', cantidad: 2,
    tarifaId, medio: 'EFECTIVO', recibido: 2000, idemKey: 'ingreso-dos',
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'YA_DENTRO');

  r = await req(ctx.base, ctx.cookie, `/visitas/${visitaId}/egresar`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.estado, 'FINALIZADA');

  const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-caja-pdf-'));
  const pdf = await generarComprobante(ctx.db, numeroComprobante, pdfDir);
  assert.equal(fs.existsSync(pdf), true);
  assert.ok(fs.statSync(pdf).size > 1000);

  const rPdf = await fetch(`${ctx.base}/api/comprobantes/${numeroComprobante}.pdf`, {
    headers: { cookie: ctx.cookie, 'X-Requested-With': 'control-caja' },
  });
  assert.equal(rPdf.status, 200);
  assert.equal(rPdf.headers.get('content-type'), 'application/pdf');
  assert.match(rPdf.headers.get('content-disposition') || '', /inline/);

  r = await req(ctx.base, ctx.cookie, '/visitas', {
    dni: '87654321', nombre: 'Ana', apellido: 'Lopez', cantidad: 2,
    tarifaId, medio: 'TRANSFERENCIA', referencia: 'TRX-123', verificada: true,
    idemKey: 'ingreso-transferencia',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.medio, 'TRANSFERENCIA');
  assert.equal(r.data.estado, 'PAGADO');
});

test('crear, activar, modificar y eliminar tarifas por API', async (t) => {
  const ctx = await iniciar();
  t.after(() => ctx.server.close());

  const call = async (method, url, body) => {
    const r = await fetch(`${ctx.base}/api${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'control-caja',
        cookie: ctx.cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  let r = await call('POST', '/tarifas', {
    nombre: 'Familiar', descripcion: 'Promocion familiar',
    cantidad: 4, precio: 250000, activa: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.nombre, 'Familiar');
  const id = r.data.id;

  r = await call('PATCH', `/tarifas/${id}`, { activa: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.activa, false);

  r = await call('PATCH', `/tarifas/${id}`, { nombre: 'Familiar modificada', precio: 275000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.nombre, 'Familiar modificada');

  r = await call('PATCH', `/tarifas/${r.data.cantidad}`, { activa: true });
  assert.equal(r.status, 200);

  r = await call('DELETE', `/tarifas/${id}`);
  assert.equal(r.status, 200);
});
