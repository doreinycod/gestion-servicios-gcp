// =====================================================================
// MOD-FAC · Facturación NCF / e-CF (proceso 4.0)
// FAC-P01 Emisión de factura y e-CF · FAC-P02 Mis facturas · FAC-P03 Control de e-CF y secuencias
// FAC-P04 Notas de crédito (e34) y débito (e33)
// =====================================================================
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { exec, one, query, transaction, HOY, AHORA } from '../config/db.js'
import { tipoEcf, formatoNcf, codigoSeguridad, rncValido, round2, calcularTotales, cedulaValida, ITBIS } from '../lib/fiscal.js'
import { pad, badRequest, conflict, forbidden, notFound, validar, HttpError } from '../lib/http.js'
import { lineasCobro, facturaDelServicio } from '../lib/totales.js'
import { DIR_ECF } from '../config/rutas.js'
import { notificar, notificarAdmins, auditar } from './mod-adm.js'
import { crearVoucher } from '../lib/vouchers.js'
import { Router } from 'express'
import { autenticar, soloRol } from '../middleware/auth.js'

const STORAGE = DIR_ECF
const EMISOR_XML = { rnc: '132456789', razon: 'Directorio Servicios, SRL' }
const esc = (s = '') => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// Documentos fiscales: prefijo del número interno y nombre impreso (columna "P" del formato e-CF)
const PREFIJO = { Factura: 'FAC', 'Nota de crédito': 'NC', 'Nota de débito': 'ND' }
export const NOMBRE_ECF = {
  e31: 'Factura de Crédito Fiscal Electrónica', e32: 'Factura de Consumo Electrónica',
  e33: 'Nota de Débito Electrónica', e34: 'Nota de Crédito Electrónica',
}
// Códigos de modificación (InformacionReferencia · CodigoModificacion)
export const CODIGO_MODIFICACION = { 1: 'Anula el comprobante', 2: 'Corrige texto', 3: 'Corrige montos', 5: 'Sustituye factura de consumo' }
// Una nota de crédito emitida después de 30 días de la factura no da derecho a rebajar el ITBIS (IndicadorNotaCredito = 1)
const DIAS_NOTA_CREDITO = 30
const diasDesde = (fecha) => Math.floor((Date.now() - new Date(fecha).getTime()) / 86_400_000)

/**
 * XML del e-CF en modo simulado (estructura simplificada del formato DGII).
 * Con proveedor, la plataforma genera y firma el XML oficial.
 */
function generarXml({ factura, comprador, lineas, ecf, referencia }) {
  const items = lineas.map((l, i) => `
    <Item><NumeroLinea>${i + 1}</NumeroLinea><NombreItem>${esc(l.descripcion)}</NombreItem>
      <CantidadItem>${l.cantidad}</CantidadItem><PrecioUnitarioItem>${Number(l.precio_unitario).toFixed(2)}</PrecioUnitarioItem>
      <MontoItem>${(l.total_linea - l.itbis_linea).toFixed(2)}</MontoItem></Item>`).join('')
  const ref = referencia ? `
  <InformacionReferencia><NCFModificado>${referencia.NCFModificado}</NCFModificado><FechaNCFModificado>${referencia.FechaNCFModificado}</FechaNCFModificado>
    <CodigoModificacion>${referencia.CodigoModificacion}</CodigoModificacion>${referencia.RazonModificacion ? `<RazonModificacion>${esc(referencia.RazonModificacion)}</RazonModificacion>` : ''}</InformacionReferencia>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<ECF>
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc><TipoeCF>${ecf.tipo_ecf.slice(1)}</TipoeCF><eNCF>${ecf.ncf}</eNCF><FechaVencimientoSecuencia>${ecf.vencimiento}</FechaVencimientoSecuencia></IdDoc>
    <Emisor><RNCEmisor>${EMISOR_XML.rnc}</RNCEmisor><RazonSocialEmisor>${EMISOR_XML.razon}</RazonSocialEmisor><FechaEmision>${new Date(factura.fecha_emision).toISOString().slice(0, 10)}</FechaEmision></Emisor>
    <Comprador><RNCComprador>${esc(comprador.rnc || '')}</RNCComprador><RazonSocialComprador>${esc(comprador.razon || '')}</RazonSocialComprador></Comprador>
    <Totales><MontoGravadoTotal>${(factura.subtotal - factura.descuento).toFixed(2)}</MontoGravadoTotal><TotalITBIS>${Number(factura.itbis).toFixed(2)}</TotalITBIS><MontoTotal>${Number(factura.total).toFixed(2)}</MontoTotal></Totales>
  </Encabezado>
  <DetallesItems>${items}
  </DetallesItems>${ref}
  <CodigoSeguridad>${ecf.codigo_seguridad}</CodigoSeguridad>
</ECF>`
}

/** Líneas facturables: de la solicitud (total, anticipo, saldo o cargo), o la cuota del plan si es un pago de suscripción. */
async function lineasDelPago(pago, cx) {
  if (pago.id_solicitud) return lineasCobro(pago.id_solicitud, pago.tipo_pago || 'Total', cx, pago.id_cargo)
  const plan = await one(
    'SELECT p.nombre, p.precio_mensual, p.periodicidad FROM suscripciones s JOIN planes p ON p.id_plan = s.id_plan WHERE s.id_suscripcion = ?',
    [pago.id_suscripcion],
    cx,
  )
  const meses = { Mensual: 1, Trimestral: 3, Anual: 12 }[plan.periodicidad] || 1
  const precio = Number(plan.precio_mensual)
  return calcularTotales([{ id_servicio: null, nombre: `Suscripción plan ${plan.nombre} (${plan.periodicidad.toLowerCase()})`, cantidad: meses, precio_unitario: precio, subtotal: precio * meses, aplica_itbis: true }])
}

/** Comprador declarado en el e-CF: RNC/cédula (si tiene) y nombre. En e31 ambos son obligatorios. */
function compradorDeCliente(cliente, tipo) {
  const rnc = String(cliente.rnc_cedula || '').replace(/\D/g, '') || null
  const razon = tipo === 'e31' || rnc ? (cliente.razon_social || cliente.nombre_completo || 'CONSUMIDOR FINAL').slice(0, 150) : null
  return { rnc, razon }
}

// ---------------------------------------------------------------------
// Proveedor de facturación electrónica (plataforma e-CF con X-API-Key).
// Asigna el e-NCF, firma con el certificado .p12, envía a la DGII y devuelve
// TrackId, estado, código de seguridad y la URL oficial de consulta (QR).
// Sin ECF_API_URL / ECF_API_KEY el sistema usa el modo simulado.
// ---------------------------------------------------------------------
export const proveedorActivo = () => !!(process.env.ECF_API_URL && process.env.ECF_API_KEY)

async function apiEcf(metodo, ruta, cuerpo) {
  const base = process.env.ECF_API_URL.replace(/\/$/, '')
  const opciones = {
    method: metodo,
    headers: { 'X-API-Key': process.env.ECF_API_KEY, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  }
  let r
  // Las consultas (GET) se reintentan una vez ante fallos de red. Los envíos (POST) no: si el primero llegó
  // y solo se perdió la respuesta, reintentar emitiría un segundo e-NCF para la misma factura.
  for (let intento = 1; ; intento++) {
    try {
      r = await fetch(base + ruta, { ...opciones, signal: AbortSignal.timeout(90_000) })
      break
    } catch (e) {
      if (metodo !== 'GET' || intento >= 2) {
        throw new Error(`Sin conexión con la plataforma e-CF (${e.cause?.code || e.name || e.message})`, { cause: e })
      }
      await new Promise((ok) => setTimeout(ok, 2000))
    }
  }
  const texto = await r.text()
  let data
  try { data = JSON.parse(texto) } catch { data = texto }
  if (!r.ok) {
    const detalle = typeof data === 'string' ? data.slice(0, 400) : [].concat(data?.message || data?.error || 'error').join('; ')
    const e = new Error(`Plataforma e-CF ${r.status}: ${detalle}`)
    e.status = r.status
    throw e
  }
  return data
}

// Formas de pago DGII: 1 efectivo, 2 cheque/transferencia/depósito, 3 tarjeta, 7 nota de crédito (voucher), 8 otras (PayPal)
const FORMA_PAGO = { Efectivo: 1, Transferencia: 2, Tarjeta: 3, Voucher: 7, PayPal: 8 }
// Plazo declarado para el saldo de una factura pagada en abonos
const DIAS_CREDITO = 30
const f2 = (n) => Number(n).toFixed(2)

/**
 * Documento e-CF (formato DGII v1.0). El proveedor completa eNCF, Emisor y fechas.
 * Notas (e33/e34) y sustitución (e31 código 5) llevan InformacionReferencia.
 * La nota de crédito no admite TablaFormasPago y exige IndicadorNotaCredito.
 * Si lo cobrado es menor que el total (factura del servicio con el anticipo), el pago es a crédito:
 * se declara lo recibido en TablaFormasPago y el resto vence en DIAS_CREDITO.
 */
function construirDocumento({ factura, lineas, comprador, metodoPago, pagado, conVoucher = 0, tipo, referencia, indicadorNotaCredito }) {
  const items = lineas.map((l, i) => ({
    NumeroLinea: String(i + 1),
    IndicadorFacturacion: Number(l.itbis_linea) > 0 ? '1' : '4', // 1 = ITBIS 18 %, 4 = exento
    NombreItem: String(l.descripcion).slice(0, 80),
    IndicadorBienoServicio: /^Materiales/i.test(l.descripcion) ? '1' : '2', // 1 = bien (materiales), 2 = servicio
    CantidadItem: String(l.cantidad),
    UnidadMedida: '43',
    PrecioUnitarioItem: f2(l.precio_unitario),
    MontoItem: f2(l.cantidad * l.precio_unitario),
  }))
  const gravado = round2(lineas.filter((l) => Number(l.itbis_linea) > 0).reduce((s, l) => s + l.cantidad * l.precio_unitario, 0))
  const exento = round2(lineas.filter((l) => !(Number(l.itbis_linea) > 0)).reduce((s, l) => s + l.cantidad * l.precio_unitario, 0))
  const credito = tipo !== 'e34' && pagado != null && round2(pagado) < round2(factura.total)
  return {
    ECF: {
      Encabezado: {
        Version: '1.0',
        IdDoc: {
          TipoeCF: tipo.slice(1),
          ...(tipo === 'e34' ? { IndicadorNotaCredito: indicadorNotaCredito } : {}),
          IndicadorMontoGravado: '0', // los precios no incluyen ITBIS
          TipoIngresos: '01',
          TipoPago: credito ? '2' : '1', // 2 crédito, 1 contado
          ...(credito ? { FechaLimitePago: FECHA_RD.format(new Date(Date.now() + DIAS_CREDITO * 86_400_000)).replace(/\//g, '-') } : {}),
          ...(tipo !== 'e34' && metodoPago ? { TablaFormasPago: { FormaDePago: formasDePago(metodoPago, credito ? pagado : factura.total, conVoucher) } } : {}),
        },
        ...(comprador.rnc || comprador.razon ? { Comprador: { ...(comprador.rnc ? { RNCComprador: comprador.rnc } : {}), RazonSocialComprador: comprador.razon } } : {}),
        Totales: {
          ...(gravado > 0 ? { MontoGravadoTotal: f2(gravado), MontoGravadoI1: f2(gravado), ITBIS1: '18', TotalITBIS: f2(factura.itbis), TotalITBIS1: f2(factura.itbis) } : {}),
          ...(exento > 0 ? { MontoExento: f2(exento) } : {}),
          MontoTotal: f2(factura.total),
        },
      },
      DetallesItems: { Item: items.length === 1 ? items[0] : items },
      ...(referencia ? { InformacionReferencia: referencia } : {}),
    },
  }
}

/** Formas de pago del documento: la parte cubierta con voucher (nota de crédito, 7) y el resto con el método del pago. */
function formasDePago(metodoPago, monto, conVoucher) {
  const voucher = round2(Math.min(Number(conVoucher) || 0, monto))
  const resto = round2(monto - voucher)
  return [
    ...(voucher > 0 ? [{ FormaPago: FORMA_PAGO.Voucher, MontoPago: f2(voucher) }] : []),
    ...(resto > 0 ? [{ FormaPago: FORMA_PAGO[metodoPago] || 8, MontoPago: f2(resto) }] : []),
  ]
}

/** Estado de la plataforma/DGII → estado de la tabla ecf (En proceso, Aceptado, Aceptado condicional, Rechazado). */
function estadoLocal(estado = '') {
  const s = String(estado).toLowerCase()
  if (s === 'aceptado') return 'Aceptado'
  if (s.includes('condicional')) return 'Aceptado condicional'
  if (s === 'rechazado') return 'Rechazado'
  return 'En proceso' // PENDIENTE_ENVIO, EN_PROCESO, ERROR_AL_ENVIAR_A_DGII, En Proceso, No encontrado
}

const json = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return null } })() : v)

/** Mensajes de la DGII (último TRACK_STATUS / RESPUESTA_DGII) o el error de la plataforma. */
function mensajesDe(doc) {
  const eventos = json(doc.responseJson) || []
  for (const ev of [...eventos].reverse()) {
    const m = ev?.data?.mensajes
    if (Array.isArray(m) && m.length) return m.map((x) => `${x.codigo ? `[${x.codigo}] ` : ''}${x.valor}`).join(' · ').slice(0, 1000)
    if (ev?.data?.error) return String(ev.data.error).slice(0, 1000)
  }
  return doc.errorMessage ? String(doc.errorMessage).slice(0, 1000) : null
}

const fechaIso = (ddmmaaaa) => (ddmmaaaa && /^\d{2}-\d{2}-\d{4}$/.test(ddmmaaaa) ? ddmmaaaa.split('-').reverse().join('-') : null)
const FECHA_RD = new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Santo_Domingo', day: '2-digit', month: '2-digit', year: 'numeric' })

/** Fecha de emisión (dd-MM-AAAA) del comprobante modificado, tal como se declaró a la DGII. */
function fechaComprobante(o) {
  const declarada = json(o.emisor_json)?.FechaEmision
  if (/^\d{2}-\d{2}-\d{4}$/.test(declarada || '')) return declarada
  if (/^\d{2}-\d{2}-\d{4}/.test(o.fecha_firma || '')) return o.fecha_firma.slice(0, 10)
  return FECHA_RD.format(new Date(o.fecha_emision)).replace(/\//g, '-')
}

/** Guarda (o actualiza, si es un reenvío) el e-CF devuelto por la plataforma y avisa según el estado. */
async function guardarEcf(id_factura, tipo, doc) {
  const req = json(doc.requestJson)?.ECF?.Encabezado
  const fechaFirma = doc.dgiiUrl ? new URL(doc.dgiiUrl).searchParams.get('fechafirma') : null
  const valores = [
    doc.encf, tipo, fechaIso(req?.IdDoc?.FechaVencimientoSecuencia), doc.codigoSeguridad || '------', doc.xmlUrl || '', doc.trackId || null,
    estadoLocal(doc.estado), mensajesDe(doc), doc.id, doc.dgiiUrl || null, req?.Emisor ? JSON.stringify(req.Emisor) : null, fechaFirma, doc.ambiente || null,
  ]
  const previo = await one('SELECT id_ecf, estado_dgii FROM ecf WHERE id_factura = ?', [id_factura])
  if (previo) {
    await exec(
      `UPDATE ecf SET ncf = ?, tipo_ecf = ?, fecha_vencimiento_secuencia = ?, codigo_seguridad = ?, xml_url = ?, track_id = ?, estado_dgii = ?,
              mensaje_dgii = ?, proveedor_id = ?, url_consulta = ?, emisor_json = ?, fecha_firma = ?, ambiente = ?, fecha_envio = ${AHORA}
        WHERE id_ecf = ?`, [...valores, previo.id_ecf])
  } else {
    await exec(
      `INSERT INTO ecf (ncf, tipo_ecf, fecha_vencimiento_secuencia, codigo_seguridad, xml_url, track_id, estado_dgii, mensaje_dgii,
                        proveedor_id, url_consulta, emisor_json, fecha_firma, ambiente, id_factura, fecha_envio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${AHORA})`, [...valores, id_factura])
  }
  await exec('UPDATE facturas SET error_ecf = NULL WHERE id_factura = ?', [id_factura])
  await registrarUsoSecuencia(doc.encf, tipo, doc.ambiente, fechaIso(req?.IdDoc?.FechaVencimientoSecuencia)).catch((e) => console.error('[secuencias]', e.message))
  const e = await one('SELECT id_ecf FROM ecf WHERE id_factura = ?', [id_factura])
  await avisarEstado(e.id_ecf, previo?.estado_dgii)
  return e.id_ecf
}

/**
 * Evita duplicados: si un envío anterior falló por red, el documento pudo llegar a la plataforma.
 * Busca uno del mismo tipo, monto y comprador creado después del documento y no ligado a otro.
 */
async function buscarEnProveedor(f, tipo, rncComprador) {
  const desde = new Date(f.fecha_emision).toISOString().slice(0, 10)
  const lista = await apiEcf('GET', `/api/v1/ecf?fechaDesde=${desde}&limit=100`)
  const usados = new Set((await query('SELECT proveedor_id FROM ecf WHERE proveedor_id IS NOT NULL')).map((x) => x.proveedor_id))
  return (lista.data || []).find((d) => {
    const enc = json(d.requestJson)?.ECF?.Encabezado
    return !usados.has(d.id) && new Date(d.createdAt) >= new Date(f.fecha_emision) && enc?.IdDoc?.TipoeCF === tipo.slice(1) &&
      enc?.Totales?.MontoTotal === f2(f.total) && (enc?.Comprador?.RNCComprador || '') === (rncComprador || '')
  }) || null
}

/** Documento con su pago, su e-CF y el comprobante que modifica (si es una nota o una sustitución). */
async function documentoParaEmitir(id_factura) {
  const f = await one(
    `SELECT f.id_factura, f.id_cliente, f.numero_factura, f.fecha_emision, f.subtotal, f.descuento, f.itbis, f.total, f.estado, f.error_ecf,
            f.tipo_documento, f.tipo_ecf, f.rnc_comprador, f.razon_social_comprador, f.id_factura_origen, f.codigo_modificacion, f.razon_modificacion,
            p.metodo_pago, p.monto AS monto_pago, p.monto_voucher, e.id_ecf, e.estado_dgii
       FROM facturas f LEFT JOIN pagos p ON p.id_pago = f.id_pago LEFT JOIN ecf e ON e.id_factura = f.id_factura
      WHERE f.id_factura = ?`, [id_factura])
  if (!f) return null
  if (!f.tipo_ecf || (!f.rnc_comprador && !f.razon_social_comprador)) {
    // Documentos creados antes de guardar el comprador: se toma del perfil del cliente
    const cliente = await one(
      `SELECT c.*, CONCAT(u.nombre, ' ', u.apellido) AS nombre_completo FROM clientes c JOIN usuarios u ON u.id_usuario = c.id_usuario WHERE c.id_cliente = ?`,
      [f.id_cliente])
    f.tipo_ecf ||= tipoEcf(cliente)
    const c = compradorDeCliente(cliente, f.tipo_ecf)
    f.rnc_comprador = c.rnc
    f.razon_social_comprador = c.razon
    await exec('UPDATE facturas SET tipo_ecf = ?, rnc_comprador = ?, razon_social_comprador = ? WHERE id_factura = ?', [f.tipo_ecf, c.rnc, c.razon, id_factura])
  }
  if (f.id_factura_origen) {
    f.origen = await one(
      `SELECT f.id_factura, f.numero_factura, f.fecha_emision, e.ncf, e.estado_dgii, e.emisor_json, e.fecha_firma
         FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?`, [f.id_factura_origen])
  }
  return f
}

/** InformacionReferencia del documento (null si es una factura normal). RazonModificacion solo se admite en notas (33/34). */
function referenciaDe(f) {
  if (!f.origen) return null
  if (!f.origen.ncf) throw new Error(`El comprobante modificado ${f.origen.numero_factura} aún no tiene e-NCF`)
  const nota = f.tipo_ecf === 'e33' || f.tipo_ecf === 'e34'
  return {
    NCFModificado: f.origen.ncf,
    FechaNCFModificado: fechaComprobante(f.origen),
    CodigoModificacion: String(f.codigo_modificacion),
    ...(nota && f.razon_modificacion ? { RazonModificacion: f.razon_modificacion.slice(0, 90) } : {}),
  }
}

/** Envía a la plataforma e-CF el documento (primer envío o reenvío de un rechazado). */
export async function emitirConProveedor(id_factura, { avisarError = true } = {}) {
  const f = await documentoParaEmitir(id_factura)
  if (!f || f.estado !== 'Emitida') return null
  if (f.id_ecf && f.estado_dgii !== 'Rechazado') return f.id_ecf
  const lineas = await query('SELECT * FROM factura_detalle WHERE id_factura = ? ORDER BY id_factura_detalle', [id_factura])
  const comprador = { rnc: f.rnc_comprador, razon: f.razon_social_comprador }
  let doc
  try {
    const referencia = referenciaDe(f)
    const existente = f.error_ecf && !f.id_ecf ? await buscarEnProveedor(f, f.tipo_ecf, comprador.rnc) : null
    doc = existente || await apiEcf('POST', '/api/v1/ecf/send', construirDocumento({
      factura: f, lineas, comprador, metodoPago: f.metodo_pago, pagado: f.monto_pago, conVoucher: f.monto_voucher, tipo: f.tipo_ecf, referencia,
      indicadorNotaCredito: f.origen && diasDesde(f.origen.fecha_emision) > DIAS_NOTA_CREDITO ? '1' : '0',
    }))
    if (!doc?.encf) throw new Error(doc?.errorMessage || 'La plataforma e-CF no asignó e-NCF')
    try { doc = { ...doc, ...(await apiEcf('GET', `/api/v1/ecf/${doc.id}/status`)) } } catch { /* se usa la respuesta del envío */ }
  } catch (e) {
    await exec('UPDATE facturas SET error_ecf = ? WHERE id_factura = ?', [e.message.slice(0, 1000), id_factura])
    if (avisarError) await notificarAdmins({ tipo: 'Factura', titulo: `No se pudo emitir el e-CF de ${f.numero_factura}`, mensaje: `${e.message.slice(0, 300)}. Se reintentará automáticamente.` })
    return null
  }
  return guardarEcf(id_factura, f.tipo_ecf, doc)
}

/** Modo simulado: toma el e-NCF de la secuencia autorizada local, genera el XML y lo "envía". */
async function emitirSimulado(id_factura) {
  const f = await documentoParaEmitir(id_factura)
  if (!f || f.id_ecf) return f?.id_ecf || null
  if (f.origen && !f.origen.ncf) return null
  const id_ecf = await transaction(async (cx) => {
    const sec = await one(
      `SELECT TOP 1 * FROM secuencias_ecf WITH (UPDLOCK, ROWLOCK) WHERE tipo_ecf = ? AND estado = 'Vigente' AND ambiente IS NULL
          AND vencimiento >= ${HOY} AND ultimo_usado < hasta ORDER BY id_secuencia`,
      [f.tipo_ecf], cx)
    if (!sec) {
      await notificarAdmins({ tipo: 'Factura', titulo: 'Solicitar nueva secuencia e-NCF', mensaje: `No hay secuencia ${f.tipo_ecf} vigente. El documento ${f.numero_factura} queda pendiente de e-NCF.` }, cx)
      return null
    }
    const siguiente = Math.max(sec.ultimo_usado + 1, sec.desde)
    await exec(`UPDATE secuencias_ecf SET ultimo_usado = ?, estado = IIF(? >= hasta, 'Agotada', estado) WHERE id_secuencia = ?`, [siguiente, siguiente, sec.id_secuencia], cx)
    const ecf = { tipo_ecf: f.tipo_ecf, ncf: formatoNcf(f.tipo_ecf, siguiente), vencimiento: sec.vencimiento, codigo_seguridad: codigoSeguridad() }
    const lineas = await query('SELECT * FROM factura_detalle WHERE id_factura = ? ORDER BY id_factura_detalle', [id_factura], cx)
    await fs.mkdir(STORAGE, { recursive: true })
    const xml = generarXml({ factura: f, comprador: { rnc: f.rnc_comprador, razon: f.razon_social_comprador }, lineas, ecf, referencia: referenciaDe(f) })
    await fs.writeFile(path.join(STORAGE, `${ecf.ncf}.xml`), xml, 'utf8')
    const e = await exec(
      `INSERT INTO ecf (id_factura, ncf, tipo_ecf, fecha_vencimiento_secuencia, codigo_seguridad, xml_url, estado_dgii, ambiente)
       VALUES (?, ?, ?, ?, ?, ?, 'En proceso', 'Simulado')`,
      [id_factura, ecf.ncf, ecf.tipo_ecf, ecf.vencimiento, ecf.codigo_seguridad, `/storage/ecf/${ecf.ncf}.xml`], cx)
    return e.insertId
  })
  if (id_ecf) await enviarDgii(id_ecf)
  return id_ecf
}

/** Emite el e-CF de un documento (factura o nota) con el proveedor o en modo simulado. */
export const emitirDocumento = (id_factura, opciones) =>
  proveedorActivo() ? emitirConProveedor(id_factura, opciones) : emitirSimulado(id_factura)

/** Avisos al cambiar de estado: documento disponible al cliente, rechazo al administrador. */
async function avisarEstado(id_ecf, anterior) {
  const e = await one(
    `SELECT e.id_ecf, e.ncf, e.tipo_ecf, e.estado_dgii, e.mensaje_dgii, f.id_factura, f.numero_factura, f.tipo_documento, c.id_usuario
       FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura
       JOIN clientes c ON c.id_cliente = f.id_cliente WHERE e.id_ecf = ?`, [id_ecf])
  if (!e || e.estado_dgii === anterior) return
  const documento = e.tipo_documento === 'Factura' ? 'factura' : e.tipo_documento.toLowerCase()
  if (e.estado_dgii.startsWith('Aceptado')) {
    await exec('UPDATE facturas SET pdf_url = ? WHERE id_factura = ?', [`/facturas/${e.numero_factura}`, e.id_factura])
    await notificar(e.id_usuario, { tipo: 'Factura', titulo: `Tu ${documento} ${e.ncf} está disponible`, mensaje: `${NOMBRE_ECF[e.tipo_ecf]} ${e.numero_factura} ${e.estado_dgii.toLowerCase()} por la DGII. Puedes descargarla en Mis facturas.`, canales: ['App', 'Correo'] })
  } else if (e.estado_dgii === 'Rechazado') {
    await notificarAdmins({ tipo: 'Factura', titulo: `e-CF ${e.ncf} rechazado por la DGII`, mensaje: `${e.numero_factura}: ${e.mensaje_dgii || 'sin detalle'}. Corrija y reenvíe desde Facturación e-CF.` })
  }
}

/** Inserta un documento (factura o nota) con sus líneas y le asigna su número interno (FAC-, NC-, ND-). */
async function insertarDocumento(cx, d, lineas) {
  const f = await exec(
    `INSERT INTO facturas (id_pago, id_cliente, numero_factura, subtotal, descuento, itbis, total, tipo_documento, tipo_ecf,
                           rnc_comprador, razon_social_comprador, id_factura_origen, codigo_modificacion, razon_modificacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.id_pago ?? null, d.id_cliente, `TMP-${crypto.randomUUID().slice(0, 10)}`, d.subtotal, d.descuento, d.itbis, d.total,
      d.tipo_documento || 'Factura', d.tipo_ecf, d.comprador.rnc, d.comprador.razon,
      d.id_factura_origen ?? null, d.codigo_modificacion ?? null, d.razon_modificacion?.slice(0, 90) ?? null],
    cx,
  )
  const numero = `${PREFIJO[d.tipo_documento || 'Factura']}-${pad(f.insertId, 6)}`
  await exec('UPDATE facturas SET numero_factura = ? WHERE id_factura = ?', [numero, f.insertId], cx)
  for (const l of lineas) {
    await exec(
      `INSERT INTO factura_detalle (id_factura, id_servicio, descripcion, cantidad, precio_unitario, itbis_linea, total_linea)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [f.insertId, l.id_servicio ?? null, String(l.descripcion).slice(0, 150), l.cantidad, l.precio_unitario, l.itbis_linea, l.total_linea],
      cx,
    )
  }
  return { id_factura: f.insertId, numero }
}

/**
 * Factura de la solicitud a la que se le aplica la nota de débito de un cargo adicional:
 * el último documento vigente con e-NCF (normalmente la factura del saldo).
 */
async function facturaDeReferencia(id_solicitud, cx) {
  return one(
    `SELECT TOP 1 f.id_factura, f.rnc_comprador, f.razon_social_comprador, f.tipo_ecf
       FROM facturas f JOIN pagos p ON p.id_pago = f.id_pago JOIN ecf e ON e.id_factura = f.id_factura
      WHERE p.id_solicitud = ? AND f.tipo_documento = 'Factura' AND f.estado = 'Emitida' AND e.estado_dgii LIKE 'Aceptado%'
        AND (e.proveedor_id IS NOT NULL OR ? = 0)
      ORDER BY f.id_factura DESC`, [id_solicitud, proveedorActivo() ? 1 : 0], cx)
}

/** Líneas de factura_detalle a partir de las líneas de un cobro. */
const lineasFactura = (t) => t.detalle.map((l) => ({
  id_servicio: l.id_servicio ?? null,
  descripcion: l.nombre || l.descripcion || 'Servicio',
  cantidad: l.cantidad,
  precio_unitario: l.precio_neto,
  itbis_linea: l.itbis_linea,
  total_linea: l.total_linea,
}))

/**
 * Saldo de un servicio con factura emitida: se abona a esa factura. Los materiales agregados al cerrar
 * se facturan con una nota de débito (e33, código 3) sobre ella, ligada al pago del saldo.
 */
async function abonarSaldo(cx, pago, servicio) {
  const saldo = await lineasCobro(pago.id_solicitud, 'Saldo', cx)
  if (round2(saldo.total) !== round2(pago.monto)) {
    await notificarAdmins({ tipo: 'Factura', titulo: `Diferencia en pago PAG-${pago.id_pago}`, mensaje: `El saldo por cobrar (${saldo.total}) no coincide con el monto pagado (${pago.monto}).` }, cx)
  }
  const m = await lineasCobro(pago.id_solicitud, 'Materiales', cx)
  if (!(m.total > 0)) return null
  return insertarDocumento(cx, {
    id_pago: pago.id_pago, id_cliente: pago.id_cliente, subtotal: m.subtotal, descuento: m.descuento, itbis: m.itbis, total: m.total,
    tipo_documento: 'Nota de débito', tipo_ecf: 'e33', id_factura_origen: servicio.id_factura, codigo_modificacion: 3,
    razon_modificacion: 'Materiales utilizados en el servicio', comprador: { rnc: servicio.rnc_comprador, razon: servicio.razon_social_comprador },
  }, lineasFactura(m))
}

/**
 * Proceso 4.0 · Generar factura (FAC-P01). Se dispara cuando un pago pasa a Confirmado.
 * Un solo documento vigente por pago; e31 solo con RNC válido.
 *  - Anticipo: factura del servicio por el 100 % de los servicios; el anticipo es su primer abono.
 *  - Saldo: se abona a esa misma factura. Si se agregaron materiales al cerrar, se facturan con una
 *    nota de débito (e33) sobre ella; si no, el saldo no genera documento.
 *  - Cargo adicional: nota de débito (e33) que referencia la factura del servicio.
 */
export async function generarFactura(id_pago) {
  const res = await transaction(async (cx) => {
    const pago = await one('SELECT * FROM pagos WITH (UPDLOCK, ROWLOCK) WHERE id_pago = ?', [id_pago], cx)
    if (!pago || pago.estado !== 'Confirmado') return null
    if (await one('SELECT id_factura FROM facturas WHERE id_pago = ?', [id_pago], cx)) return null

    const cliente = await one(
      `SELECT c.*, CONCAT(u.nombre, ' ', u.apellido) AS nombre_completo, u.id_usuario, u.email
         FROM clientes c JOIN usuarios u ON u.id_usuario = c.id_usuario WHERE c.id_cliente = ?`,
      [pago.id_cliente],
      cx,
    )
    if (pago.tipo_pago === 'Saldo') {
      const servicio = await facturaDelServicio(pago.id_solicitud, cx)
      if (servicio) return abonarSaldo(cx, pago, servicio)
      // Anticipo facturado antes del esquema de abonos (o anulado): el saldo lleva su propia factura
    }
    const anticipo = pago.tipo_pago === 'Anticipo'
    const t = anticipo ? await lineasCobro(pago.id_solicitud, 'Servicios', cx) : await lineasDelPago(pago, cx)
    const cobrado = anticipo ? (await lineasCobro(pago.id_solicitud, 'Anticipo', cx)).total : t.total
    if (round2(cobrado) !== round2(pago.monto)) {
      await notificarAdmins({ tipo: 'Factura', titulo: `Diferencia en pago PAG-${pago.id_pago}`, mensaje: `El total facturable (${cobrado}) no coincide con el monto pagado (${pago.monto}).` }, cx)
    }
    const lineas = lineasFactura(t)
    const doc = { id_pago, id_cliente: pago.id_cliente, subtotal: t.subtotal, descuento: t.descuento, itbis: t.itbis, total: t.total }

    if (pago.tipo_pago === 'Cargo') {
      await exec(`UPDATE cargos_adicionales SET estado = 'Pagado' WHERE id_cargo = ?`, [pago.id_cargo], cx)
      const origen = await facturaDeReferencia(pago.id_solicitud, cx)
      if (origen) {
        Object.assign(doc, {
          tipo_documento: 'Nota de débito', tipo_ecf: 'e33', id_factura_origen: origen.id_factura, codigo_modificacion: 3,
          razon_modificacion: `Cargo adicional: ${t.cargo.descripcion}`, comprador: { rnc: origen.rnc_comprador, razon: origen.razon_social_comprador },
        })
        return insertarDocumento(cx, doc, lineas)
      }
      // Sin factura previa válida en la DGII (p. ej. servicio cubierto por plan): el cargo se factura normalmente
    }
    // Comprobante elegido por el cliente al pagar (si no eligió: e31 para empresa con RNC válido, e32 en otro caso)
    const eleccion = pago.id_solicitud
      ? await one('SELECT comprobante_tipo, comprobante_rnc, comprobante_razon FROM solicitudes_servicio WHERE id_solicitud = ?', [pago.id_solicitud], cx)
      : null
    if (eleccion?.comprobante_tipo === 'e31') {
      doc.tipo_ecf = 'e31'
      doc.comprador = { rnc: eleccion.comprobante_rnc, razon: eleccion.comprobante_razon }
    } else {
      doc.tipo_ecf = eleccion?.comprobante_tipo || tipoEcf(cliente)
      doc.comprador = compradorDeCliente(cliente, doc.tipo_ecf)
    }
    return insertarDocumento(cx, doc, lineas)
  })
  if (res) await emitirDocumento(res.id_factura)
  return res
}

/**
 * Saldo que aún se puede acreditar sobre una factura: su total + notas de débito vigentes
 * − notas de crédito vigentes (sin contar las que revierten una nota de débito, que ya quedó anulada).
 */
async function disponibleCredito(id_factura, cx) {
  const r = await one(
    `SELECT f.total
            + (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de débito' AND n.estado = 'Emitida')
            - (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de crédito'
                  AND n.estado = 'Emitida' AND n.id_nota_revertida IS NULL) AS disponible,
            (SELECT COUNT(*) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento IN ('Nota de crédito', 'Nota de débito')
                  AND n.estado = 'Emitida' AND n.id_nota_revertida IS NULL) AS notas
       FROM facturas f WHERE f.id_factura = ?`, [id_factura], cx)
  return { disponible: round2(r.disponible), notas: r.notas }
}

/** Líneas de la nota: copia exacta (factor 1) o cada línea reducida en la misma proporción. */
function lineasNota(base, factor, prefijo) {
  if (factor === 1) {
    return base.map((l) => ({ ...l, precio_unitario: Number(l.precio_unitario), itbis_linea: Number(l.itbis_linea), total_linea: Number(l.total_linea) }))
  }
  return base.map((l) => {
    const neto = round2((Number(l.total_linea) - Number(l.itbis_linea)) * factor)
    const itbis = Number(l.itbis_linea) > 0 ? round2(neto * ITBIS) : 0
    return { id_servicio: l.id_servicio, descripcion: `${prefijo}: ${l.descripcion}`, cantidad: 1, precio_unitario: neto, itbis_linea: itbis, total_linea: round2(neto + itbis) }
  }).filter((l) => l.precio_unitario > 0)
}

const totalesDe = (lineas) => {
  const subtotal = round2(lineas.reduce((s, l) => s + l.cantidad * l.precio_unitario, 0))
  const itbis = round2(lineas.reduce((s, l) => s + l.itbis_linea, 0))
  return { subtotal, descuento: 0, itbis, total: round2(subtotal + itbis) }
}

/**
 * FAC-P04 · Nota de crédito (e34) sobre un documento con e-NCF.
 *  - Factura, total (código 1): anula el comprobante; el documento queda Anulado.
 *  - Factura, parcial (código 3): corrige montos; cada línea se reduce en la misma proporción.
 *  - Nota de débito: la DGII no permite que una nota modifique a otra (regla 655), así que la NC
 *    se aplica a la factura original por el monto de la ND (código 3) y la ND queda Anulada.
 * Devuelve el documento creado; el e-CF se emite al confirmar la transacción.
 */
export async function crearNotaCredito(cx, { id_factura, razon, monto = null }) {
  const doc = await one(
    `SELECT f.*, e.ncf, e.estado_dgii, e.proveedor_id FROM facturas f WITH (UPDLOCK, ROWLOCK) LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?`,
    [id_factura], cx)
  if (!doc) throw notFound('Documento no encontrado')
  if (doc.tipo_documento === 'Nota de crédito') throw conflict('No se puede aplicar una nota de crédito a otra nota de crédito')
  if (doc.estado !== 'Emitida') throw conflict(`El documento ${doc.numero_factura} ya está anulado`)
  if (!doc.ncf || !String(doc.estado_dgii).startsWith('Aceptado')) throw conflict('El comprobante debe estar aceptado por la DGII')
  if (proveedorActivo() && !doc.proveedor_id) throw conflict('El comprobante se emitió en modo simulado y no existe en la DGII')

  const esDebito = doc.tipo_documento === 'Nota de débito'
  const id_origen = esDebito ? doc.id_factura_origen : doc.id_factura
  const o = esDebito
    ? await one('SELECT f.*, e.ncf FROM facturas f WITH (UPDLOCK, ROWLOCK) LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?', [id_origen], cx)
    : doc
  if (o.estado !== 'Emitida') throw conflict(`La factura ${o.numero_factura} ya está anulada`)
  const base = await query('SELECT * FROM factura_detalle WHERE id_factura = ? ORDER BY id_factura_detalle', [doc.id_factura], cx)

  let lineas, codigo, anulaFactura = false
  if (esDebito) {
    if (monto !== null && round2(monto) !== round2(doc.total)) throw badRequest(`Una nota de débito se revierte completa: RD$ ${Number(doc.total).toFixed(2)}`)
    lineas = lineasNota(base, 1)
    lineas = lineas.map((l) => ({ ...l, descripcion: `Reverso ${doc.numero_factura}: ${l.descripcion}` }))
    codigo = 3
  } else {
    const { disponible, notas } = await disponibleCredito(o.id_factura, cx)
    if (monto === null && notas > 0) throw conflict(`La factura ya tiene notas aplicadas. Indique un monto parcial (disponible: RD$ ${disponible.toFixed(2)})`)
    if (monto !== null && (!(monto > 0) || round2(monto) > disponible)) throw badRequest(`El monto debe estar entre RD$ 0.01 y RD$ ${disponible.toFixed(2)}`)
    if (monto === null || (notas === 0 && round2(monto) === round2(o.total))) {
      lineas = lineasNota(base, 1)
      codigo = 1
      anulaFactura = true
    } else {
      lineas = lineasNota(base, round2(monto) / Number(o.total), 'Ajuste')
      codigo = 3
    }
  }
  const totales = codigo === 1 ? { subtotal: o.subtotal, descuento: o.descuento, itbis: o.itbis, total: o.total } : totalesDe(lineas)
  const nota = await insertarDocumento(cx, {
    ...totales, id_cliente: o.id_cliente, tipo_documento: 'Nota de crédito', tipo_ecf: 'e34',
    id_factura_origen: o.id_factura, codigo_modificacion: codigo, razon_modificacion: razon,
    comprador: { rnc: o.rnc_comprador, razon: o.razon_social_comprador },
  }, lineas)
  if (esDebito) {
    await exec('UPDATE facturas SET id_nota_revertida = ? WHERE id_factura = ?', [doc.id_factura, nota.id_factura], cx)
    await exec("UPDATE facturas SET estado = 'Anulada' WHERE id_factura = ?", [doc.id_factura], cx)
  }
  if (anulaFactura) await exec("UPDATE facturas SET estado = 'Anulada' WHERE id_factura = ?", [o.id_factura], cx)
  return { ...nota, total: totales.total, origen: doc }
}

/** Nota de crédito total sobre un documento; si nunca llegó a la DGII, basta con anular el documento interno. */
async function anularDocumento(cx, f, razon) {
  if (!f) return null
  if (!f.ncf) {
    await exec("UPDATE facturas SET estado = 'Anulada', error_ecf = NULL WHERE id_factura = ?", [f.id_factura], cx)
    return null
  }
  return crearNotaCredito(cx, { id_factura: f.id_factura, razon })
}

/**
 * Reembolso de un pago (PAG-P06): notas de crédito que lo respaldan. Se llama con el pago ya Reembolsado.
 *  - Pago con su propia factura (total, cargo, plan, saldo antiguo): nota de crédito total sobre ella.
 *  - Abono a la factura del servicio (anticipo o saldo): si el otro abono sigue vigente, nota de crédito
 *    parcial por lo abonado; si no queda ninguno, se anula lo que resta de la factura. Los materiales del
 *    saldo (su nota de débito) se revierten completos.
 */
export async function notasCreditoDePago(cx, id_pago, motivo) {
  const razon = `Reembolso: ${motivo}`
  const pago = await one('SELECT * FROM pagos WHERE id_pago = ?', [id_pago], cx)
  const propio = await one(
    `SELECT TOP 1 f.id_factura, f.total, f.tipo_documento, e.ncf FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura
      WHERE f.id_pago = ? AND f.estado = 'Emitida' AND f.tipo_documento <> 'Nota de crédito' ORDER BY f.id_factura DESC`, [id_pago], cx)
  const servicio = ['Anticipo', 'Saldo'].includes(pago.tipo_pago) ? await facturaDelServicio(pago.id_solicitud, cx) : null
  const esAbono = servicio && (pago.tipo_pago === 'Anticipo' ? servicio.id_pago_anticipo === pago.id_pago : propio?.tipo_documento !== 'Factura')
  if (!esAbono) return [await anularDocumento(cx, propio, razon)].filter(Boolean)

  const notas = []
  let abonado = Number(pago.monto)
  if (pago.tipo_pago === 'Saldo' && propio) {
    notas.push(await anularDocumento(cx, propio, razon))
    abonado = round2(abonado - Number(propio.total))
  }
  const otros = await one(
    `SELECT COUNT(*) AS n FROM pagos WHERE id_solicitud = ? AND id_pago <> ? AND estado = 'Confirmado' AND tipo_pago IN ('Anticipo', 'Saldo')`,
    [pago.id_solicitud, id_pago], cx)
  const f = await one('SELECT f.id_factura, e.ncf FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?', [servicio.id_factura], cx)
  if (!otros.n) {
    // Sin abonos vigentes: se anula la factura (o lo que queda de ella si ya tiene notas)
    const { disponible, notas: previas } = await disponibleCredito(f.id_factura, cx)
    if (!previas) notas.push(await anularDocumento(cx, f, razon))
    else if (disponible > 0) notas.push(await crearNotaCredito(cx, { id_factura: f.id_factura, razon, monto: disponible }))
  } else if (abonado > 0) {
    notas.push(await crearNotaCredito(cx, { id_factura: f.id_factura, razon, monto: abonado }))
  }
  return notas.filter(Boolean)
}

/**
 * Consulta el estado del e-CF en la DGII.
 * Con proveedor: GET /api/v1/ecf/{id}/track (consulta el TrackId y actualiza).
 * Simulado: acepta el comprobante salvo que un e31 tenga RNC inválido (reproduce el rechazo real).
 */
export async function enviarDgii(id_ecf) {
  const e = await one(
    `SELECT e.*, f.rnc_comprador FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura WHERE e.id_ecf = ?`,
    [id_ecf],
  )
  if (!e) return
  if (e.proveedor_id) {
    if (!proveedorActivo()) return
    const doc = await apiEcf('GET', `/api/v1/ecf/${e.proveedor_id}/track`)
    await exec(`UPDATE ecf SET estado_dgii = ?, mensaje_dgii = ?, track_id = COALESCE(?, track_id), codigo_seguridad = COALESCE(?, codigo_seguridad),
                       url_consulta = COALESCE(?, url_consulta) WHERE id_ecf = ?`,
      [estadoLocal(doc.estado), mensajesDe(doc), doc.trackId || null, doc.codigoSeguridad || null, doc.dgiiUrl || null, id_ecf])
    await avisarEstado(id_ecf, e.estado_dgii)
    return
  }
  const track = e.track_id || crypto.randomUUID()
  let estado = 'Aceptado', mensaje = null
  if (e.tipo_ecf === 'e31' && !rncValido(e.rnc_comprador || '')) {
    estado = 'Rechazado'
    mensaje = 'RNC del comprador no válido'
  }
  await exec(`UPDATE ecf SET track_id = ?, estado_dgii = ?, mensaje_dgii = ?, fecha_envio = ${AHORA} WHERE id_ecf = ?`, [track, estado, mensaje, id_ecf])
  await avisarEstado(id_ecf, e.estado_dgii)
}

/** Documentos vigentes que aún no tienen e-NCF (error de comunicación o falta de secuencia). */
const SQL_SIN_ECF = `SELECT f.id_factura, f.numero_factura, f.tipo_documento, f.total, f.fecha_emision, f.error_ecf
   FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura
  WHERE e.id_ecf IS NULL AND f.estado = 'Emitida'`

/** Tarea programada (cada 5 min): consulta los e-CF En proceso y reintenta los documentos que no pudieron emitirse. */
export async function reintentarPendientesDgii() {
  const pendientes = await query("SELECT id_ecf FROM ecf WHERE estado_dgii = 'En proceso'")
  for (const p of pendientes) await enviarDgii(p.id_ecf).catch((e) => console.error('[e-CF consulta]', e.message))
  if (proveedorActivo()) {
    // En orden: un documento original se emite antes que la nota que lo referencia
    const sinEcf = await query(`${SQL_SIN_ECF} ORDER BY f.id_factura`)
    for (const f of sinEcf) await emitirConProveedor(f.id_factura, { avisarError: false })
  }
  return pendientes.length
}

/** Valida un RNC o cédula con la DGII (vía la plataforma e-CF). Sin plataforma, solo el dígito verificador. */
// Contribuyentes activos ya consultados (24 h): menos llamadas a la DGII y respuesta inmediata
const CACHE_RNC_MS = 24 * 3600e3
const cacheRnc = new Map()

export async function consultarContribuyente(valor) {
  const doc = String(valor || '').replace(/\D/g, '')
  if (!(rncValido(doc) || cedulaValida(doc))) return { valido: false, documento: doc, motivo: 'El RNC o la cédula no es válido (dígito verificador)' }
  if (!proveedorActivo()) return { valido: true, documento: doc, verificado: false }
  const guardado = cacheRnc.get(doc)
  if (guardado && Date.now() - guardado.t < CACHE_RNC_MS) return guardado.r
  try {
    // La consulta en línea de la DGII a veces responde "no inscrito" por un fallo momentáneo: se confirma una segunda vez
    let r = await apiEcf('GET', `/api/v1/dgii/rnc?value=${doc}`)
    if (!r?.success) {
      await new Promise((ok) => setTimeout(ok, 1200))
      r = await apiEcf('GET', `/api/v1/dgii/rnc?value=${doc}`)
    }
    if (!r?.success) return { valido: false, documento: doc, motivo: r?.message || 'No está inscrito en la DGII' }
    if (r.estado && r.estado !== 'ACTIVO') return { valido: false, documento: doc, motivo: `El contribuyente está ${String(r.estado).toLowerCase()} en la DGII` }
    const ok = { valido: true, documento: doc, verificado: true, nombre: r.nombre, nombre_comercial: r.nombreComercial, estado: r.estado }
    if (cacheRnc.size > 2000) cacheRnc.clear()
    cacheRnc.set(doc, { t: Date.now(), r: ok })
    return ok
  } catch (e) {
    // La consulta es un apoyo: si la plataforma no responde, se acepta con el dígito verificador
    console.error('[DGII RNC]', e.message)
    return { valido: true, documento: doc, verificado: false }
  }
}

const rFacturas = Router()
rFacturas.use(autenticar)

// Emisor por defecto (modo simulado). Con proveedor se usan los datos del emisor que se enviaron a la DGII.
export const EMISOR = {
  razon_social: process.env.EMISOR_RAZON_SOCIAL || 'Directorio Servicios, SRL',
  rnc: process.env.EMISOR_RNC || '1-32-45678-9',
  direccion: process.env.EMISOR_DIRECCION || 'Santiago de los Caballeros, República Dominicana',
  telefono: process.env.EMISOR_TELEFONO || '(849) 880-2724',
  correo: process.env.EMISOR_CORREO || 'facturacion@directorioservicios.do',
}

function emisorDe(emisorJson) {
  const e = json(emisorJson)
  if (!e) return EMISOR
  return {
    razon_social: e.RazonSocialEmisor, nombre_comercial: e.NombreComercial, rnc: e.RNCEmisor,
    direccion: e.DireccionEmisor, telefono: [].concat(e.TablaTelefonoEmisor?.TelefonoEmisor || [])[0] || '', correo: e.CorreoEmisor || '',
  }
}

// Pago del documento: el propio (factura, nota de débito) o el del documento que modifica (nota de crédito)
const SQL_PAGO_DOC = 'LEFT JOIN facturas fo ON fo.id_factura = f.id_factura_origen LEFT JOIN pagos p ON p.id_pago = COALESCE(f.id_pago, fo.id_pago)'

/** Saldo acreditable de f (factura: total + ND − NC; nota de débito: su total). Fragmento SQL sobre el alias f. */
const SQL_DISPONIBLE = `IIF(f.tipo_documento = 'Nota de débito', f.total, f.total
    + (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de débito' AND n.estado = 'Emitida')
    - (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de crédito'
        AND n.estado = 'Emitida' AND n.id_nota_revertida IS NULL))`

export const MOTIVOS_NC = ['Cobro de más', 'Servicio no realizado', 'Servicio incompleto o deficiente', 'Error en la factura', 'Otro']

/** El cliente puede pedir nota de crédito sobre una factura o nota de débito vigente, aceptada y con saldo. */
const puedeSolicitarNc = (f) =>
  f.tipo_documento !== 'Nota de crédito' && f.estado === 'Emitida' && String(f.estado_dgii).startsWith('Aceptado') &&
  Number(f.disponible_credito) > 0 && f.nc_estado !== 'Pendiente' && (!proveedorActivo() || !!f.proveedor_id)

// ---------- FAC-P02 · Mis facturas (incluye notas de crédito y débito) ----------
rFacturas.get('/mias', soloRol('Cliente', 'Empleado'), async (req, res) => {
  const filas = await query(
    `SELECT f.id_factura, f.numero_factura, f.fecha_emision, f.itbis, f.total, f.estado, f.tipo_documento, f.codigo_modificacion,
            COALESCE(e.tipo_ecf, f.tipo_ecf) AS tipo_ecf, e.ncf, e.estado_dgii, e.proveedor_id, fo.numero_factura AS origen_numero, eo.ncf AS origen_ncf,
            s.codigo_seguimiento AS solicitud, pl.nombre AS [plan], ${SQL_DISPONIBLE} AS disponible_credito,
            nc.id_solicitud_nc AS nc_id, nc.estado AS nc_estado, nc.tipo AS nc_tipo, nc.monto AS nc_monto, nc.respuesta AS nc_respuesta, nc.fecha_solicitud AS nc_fecha,
            (SELECT STRING_AGG(fd.descripcion, ', ') FROM factura_detalle fd WHERE fd.id_factura = f.id_factura) AS concepto
       FROM facturas f ${SQL_PAGO_DOC} LEFT JOIN ecf e ON e.id_factura = f.id_factura LEFT JOIN ecf eo ON eo.id_factura = fo.id_factura
       OUTER APPLY (SELECT TOP 1 * FROM solicitudes_nota_credito x WHERE x.id_factura = f.id_factura ORDER BY x.id_solicitud_nc DESC) nc
       LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       LEFT JOIN suscripciones su ON su.id_suscripcion = p.id_suscripcion LEFT JOIN planes pl ON pl.id_plan = su.id_plan
      WHERE f.id_cliente = ? ORDER BY f.fecha_emision DESC, f.id_factura DESC`,
    [req.usuario.id_cliente])
  res.json(filas.map(({ proveedor_id, ...f }) => ({
    ...f, puede_solicitar_nc: puedeSolicitarNc({ ...f, proveedor_id }),
  })))
})

async function facturaVisible(req, numero) {
  const f = await one(
    `SELECT f.id_factura, f.id_pago, f.id_cliente, f.numero_factura, f.fecha_emision, f.subtotal, f.descuento, f.itbis, f.total, f.estado,
            f.error_ecf, f.tipo_documento, f.codigo_modificacion, f.razon_modificacion, f.rnc_comprador, f.razon_social_comprador,
            e.id_ecf, e.ncf, COALESCE(e.tipo_ecf, f.tipo_ecf) AS tipo_ecf, e.fecha_vencimiento_secuencia, e.codigo_seguridad, e.track_id, e.estado_dgii,
            e.mensaje_dgii, e.fecha_envio, e.xml_url, e.proveedor_id, e.url_consulta, e.emisor_json, e.fecha_firma, e.ambiente,
            c.tipo_cliente, c.rnc_cedula, c.razon_social, c.direccion, CONCAT(u.nombre, ' ', u.apellido) AS cliente,
            p.metodo_pago, p.referencia, p.monto, s.codigo_seguimiento AS solicitud,
            fo.numero_factura AS origen_numero, fo.fecha_emision AS origen_fecha, eo.ncf AS origen_ncf, eo.tipo_ecf AS origen_tipo_ecf,
            (SELECT TOP 1 CONCAT(ue.nombre, ' ', ue.apellido) FROM asignaciones_servicio a JOIN empleados em ON em.id_empleado = a.id_empleado
               JOIN usuarios ue ON ue.id_usuario = em.id_usuario WHERE a.id_solicitud = p.id_solicitud AND a.estado_asignacion = 'Completada') AS prestador
       FROM facturas f JOIN clientes c ON c.id_cliente = f.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
       ${SQL_PAGO_DOC} LEFT JOIN ecf e ON e.id_factura = f.id_factura LEFT JOIN ecf eo ON eo.id_factura = fo.id_factura
       LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
      WHERE f.numero_factura = ?`,
    [numero])
  if (!f) throw notFound('Factura no encontrada')
  if (req.usuario.nombre_rol !== 'Administrador' && f.id_cliente !== req.usuario.id_cliente) throw forbidden()
  return f
}

// ---------- FAC-P01 / FAC-P02 · Datos de la representación impresa ----------
rFacturas.get('/:numero', async (req, res) => {
  const f = await facturaVisible(req, req.params.numero)
  const lineas = await query(
    'SELECT descripcion, cantidad, precio_unitario, itbis_linea, total_linea FROM factura_detalle WHERE id_factura = ? ORDER BY id_factura_detalle',
    [f.id_factura])
  // Documentos que modifican a este (notas de crédito/débito y la factura que lo sustituye)
  const modificaciones = await query(
    `SELECT f.numero_factura, f.tipo_documento, f.codigo_modificacion, f.total, f.fecha_emision, e.ncf, e.estado_dgii
       FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura_origen = ? ORDER BY f.id_factura`, [f.id_factura])
  // Factura del servicio pagada en abonos: anticipo + saldo (sin la parte del saldo que paga la nota de débito de materiales)
  const abonos = f.tipo_documento === 'Factura' && f.id_pago ? await query(
    `SELECT p.id_pago, p.tipo_pago, p.metodo_pago, p.fecha_pago, p.monto,
            p.monto - COALESCE((SELECT SUM(n.total) FROM facturas n WHERE n.id_pago = p.id_pago AND n.tipo_documento = 'Nota de débito'), 0) AS aplicado
       FROM pagos a JOIN pagos p ON p.id_solicitud = a.id_solicitud
      WHERE a.id_pago = ? AND a.tipo_pago = 'Anticipo' AND a.monto <> ? AND p.estado = 'Confirmado'
        AND (p.id_pago = a.id_pago OR (p.tipo_pago = 'Saldo' AND NOT EXISTS (SELECT 1 FROM facturas x WHERE x.id_pago = p.id_pago AND x.tipo_documento = 'Factura')))
      ORDER BY p.id_pago`, [f.id_pago, f.total]) : []
  let pendiente = null
  if (abonos.length) {
    const nc = await one(
      `SELECT COALESCE(SUM(total), 0) AS t FROM facturas WHERE id_factura_origen = ? AND tipo_documento = 'Nota de crédito' AND estado = 'Emitida' AND id_nota_revertida IS NULL`,
      [f.id_factura])
    pendiente = Math.max(0, round2(Number(f.total) - Number(nc.t) - abonos.reduce((s, a) => s + Number(a.aplicado), 0)))
  }
  if (f.id_ecf && !String(f.estado_dgii).startsWith('Aceptado')) f.aviso = `El comprobante está ${String(f.estado_dgii).toLowerCase()} en la DGII`
  if (!f.id_ecf && f.error_ecf) f.aviso = 'El comprobante fiscal aún no se ha podido emitir; se reintentará automáticamente.'
  const { xml_url, emisor_json, proveedor_id, ...datos } = f
  res.json({
    emisor: emisorDe(emisor_json), ...datos, nombre_ecf: NOMBRE_ECF[f.tipo_ecf], tiene_xml: !!(xml_url || proveedor_id), lineas,
    referencia: f.origen_numero ? {
      numero: f.origen_numero, ncf: f.origen_ncf, tipo_ecf: f.origen_tipo_ecf, fecha: f.origen_fecha,
      codigo: f.codigo_modificacion, descripcion: CODIGO_MODIFICACION[f.codigo_modificacion], razon: f.razon_modificacion,
    } : null,
    modificaciones: modificaciones.map((m) => ({ ...m, descripcion: CODIGO_MODIFICACION[m.codigo_modificacion] })),
    abonos: abonos.map((a) => ({ ...a, aplicado: round2(a.aplicado) })), pendiente,
  })
})

rFacturas.get('/:numero/xml', async (req, res) => {
  const f = await facturaVisible(req, req.params.numero)
  if (!f.xml_url && !f.proveedor_id) throw notFound('La factura aún no tiene e-CF')
  // Con proveedor: XML firmado digitalmente tal como se envió a la DGII
  const xml = f.proveedor_id
    ? await (await fetch(`${process.env.ECF_API_URL.replace(/\/$/, '')}/api/v1/ecf/${f.proveedor_id}/xml`, { headers: { 'X-API-Key': process.env.ECF_API_KEY } })).text()
    : await fs.readFile(path.join(DIR_ECF, path.basename(f.xml_url)), 'utf8')
  res.type('application/xml').attachment(`${f.ncf}.xml`).send(xml)
})

/**
 * FAC-P04 · El cliente solicita una nota de crédito (total o parcial) con su motivo.
 * Administración la aprueba (se emite la e34) o la rechaza desde Facturación e-CF.
 */
rFacturas.post('/:numero/solicitar-nota-credito', soloRol('Cliente'), async (req, res) => {
  const f = await facturaVisible(req, req.params.numero)
  const motivo = req.body.motivo
  const detalle = String(req.body.detalle || '').trim()
  const parcial = req.body.tipo === 'Parcial'
  const monto = parcial ? Number(String(req.body.monto || '').replace(/,/g, '')) : null
  validar({
    motivo: !MOTIVOS_NC.includes(motivo) && 'Seleccione el motivo',
    detalle: !(detalle.length >= 10 && detalle.length <= 500) && 'Explique lo ocurrido (10 a 500 caracteres)',
    monto: parcial && !(monto > 0) && 'Indique el monto a acreditar',
  })
  if (f.tipo_documento === 'Nota de crédito') throw conflict('No se puede pedir una nota de crédito sobre otra nota de crédito')
  if (f.tipo_documento === 'Nota de débito' && parcial) throw conflict('Una nota de débito solo se puede revertir completa')
  if (f.estado !== 'Emitida') throw conflict('El documento ya está anulado')
  if (!String(f.estado_dgii).startsWith('Aceptado')) throw conflict('El comprobante aún no está aceptado por la DGII')
  if (proveedorActivo() && !f.proveedor_id) throw conflict('Este comprobante se emitió en modo de prueba y no admite notas de crédito')
  const { disponible } = f.tipo_documento === 'Nota de débito' ? { disponible: Number(f.total) } : await disponibleCredito(f.id_factura)
  if (disponible <= 0) throw conflict('Esta factura ya fue acreditada por completo')
  if (parcial && round2(monto) > disponible) throw badRequest(`El monto no puede superar RD$ ${disponible.toFixed(2)}`)

  const x = await transaction(async (cx) => {
    if (await one("SELECT 1 AS x FROM solicitudes_nota_credito WHERE id_factura = ? AND estado = 'Pendiente'", [f.id_factura], cx)) {
      throw conflict('Ya hay una solicitud pendiente para este documento')
    }
    const r = await exec(
      `INSERT INTO solicitudes_nota_credito (id_factura, id_cliente, motivo, detalle, tipo, monto) VALUES (?, ?, ?, ?, ?, ?)`,
      [f.id_factura, f.id_cliente, motivo, detalle, parcial ? 'Parcial' : 'Total', parcial ? round2(monto) : null], cx)
    await notificarAdmins({
      tipo: 'Factura', titulo: `Solicitud de nota de crédito · ${f.numero_factura}`,
      mensaje: `${f.razon_social_comprador || f.cliente} solicita nota de crédito ${parcial ? `parcial de RD$ ${round2(monto).toFixed(2)}` : `total (RD$ ${disponible.toFixed(2)})`} sobre ${f.ncf}. Motivo: ${motivo}. Revísela en Facturación e-CF.`,
    }, cx)
    await auditar(req, 'Nota de crédito solicitada', 'solicitudes_nota_credito', r.insertId, null, { numero: f.numero_factura, motivo, tipo: parcial ? 'Parcial' : 'Total', monto }, cx)
    return r.insertId
  })
  res.status(201).json({ id_solicitud_nc: x, estado: 'Pendiente' })
})

rFacturas.post('/solicitudes-nota-credito/:id/cancelar', soloRol('Cliente'), async (req, res) => {
  const r = await one('SELECT * FROM solicitudes_nota_credito WHERE id_solicitud_nc = ?', [req.params.id])
  if (!r) throw notFound('Solicitud no encontrada')
  if (r.id_cliente !== req.usuario.id_cliente) throw forbidden()
  if (r.estado !== 'Pendiente') throw conflict('La solicitud ya fue respondida')
  await exec(`UPDATE solicitudes_nota_credito SET estado = 'Cancelada', fecha_respuesta = ${AHORA} WHERE id_solicitud_nc = ?`, [r.id_solicitud_nc])
  res.json({ estado: 'Cancelada' })
})

// =====================================================================
// FAC-P03 · Control de e-CF y secuencias (administrador)
// =====================================================================
export const adminFacturacion = Router()
adminFacturacion.use(autenticar, soloRol('Administrador'))

// Modo de emisión y ambiente del proveedor (TesteCF, CerteCF o eCF)
adminFacturacion.get('/estado', async (_req, res) => {
  if (!proveedorActivo()) return res.json({ modo: 'simulado' })
  try {
    const d = await apiEcf('GET', '/api/v1/ecf?limit=1')
    const ultimo = d.data?.[0]
    res.json({ modo: 'proveedor', conectado: true, ambiente: ultimo?.ambiente || null, documentos: d.total, emisor: ultimo ? emisorDe(json((await apiEcf('GET', `/api/v1/ecf/${ultimo.id}/status`)).requestJson)?.ECF?.Encabezado?.Emisor) : null })
  } catch (e) {
    res.json({ modo: 'proveedor', conectado: false, error: e.message })
  }
})

// ---------------------------------------------------------------------
// Secuencias e-NCF. Modo simulado: rangos locales (ambiente NULL) que usa emitirSimulado.
// Con plataforma: la plataforma asigna el e-NCF y no informa sus rangos, así que el administrador
// registra el rango autorizado por la DGII y el sistema lo monitorea con los e-NCF asignados.
// ---------------------------------------------------------------------
const TIPOS_ECF = ['e31', 'e32', 'e33', 'e34']
const ALERTA_PCT = 0.1 // aviso cuando queda menos del 10 % del rango
const ALERTA_DIAS = 30 // aviso cuando vence en menos de 30 días
const numeroNcf = (ncf) => Number(String(ncf).slice(3))

/** Ambiente actual de la plataforma (el del último e-CF emitido). */
async function ambienteActual() {
  const r = await one("SELECT TOP 1 ambiente FROM ecf WHERE proveedor_id IS NOT NULL AND ambiente IS NOT NULL ORDER BY id_ecf DESC")
  return r?.ambiente || null
}

/** Al guardar un e-CF de la plataforma, avanza el último número usado del rango que lo contiene. */
async function registrarUsoSecuencia(ncf, tipo, ambiente, vencimientoIso) {
  if (!ncf || !ambiente) return
  await exec(
    `UPDATE secuencias_ecf SET ultimo_usado = IIF(? > ultimo_usado, ?, ultimo_usado), vencimiento_informado = COALESCE(?, vencimiento_informado),
            estado = IIF(? >= hasta, 'Agotada', estado)
      WHERE ambiente = ? AND tipo_ecf = ? AND ? BETWEEN desde AND hasta`,
    [numeroNcf(ncf), numeroNcf(ncf), vencimientoIso, numeroNcf(ncf), ambiente, tipo, numeroNcf(ncf)])
}

/**
 * Último e-NCF usado por tipo: el mayor asignado a este sistema y, como la cuenta de la plataforma
 * puede usarse desde otros sistemas, se confirma en la plataforma si ya existen los siguientes números.
 */
async function ultimoUsadoEnPlataforma(tipo, ambiente) {
  const r = await one(
    `SELECT MAX(CAST(SUBSTRING(ncf, 4, 10) AS BIGINT)) AS ultimo, MAX(fecha_vencimiento_secuencia) AS vencimiento
       FROM ecf WHERE tipo_ecf = ? AND proveedor_id IS NOT NULL AND ambiente = ?`, [tipo, ambiente])
  let ultimo = r?.ultimo ? Number(r.ultimo) : null
  if (ultimo !== null && proveedorActivo()) {
    for (let i = 0; i < 25; i++) {
      try {
        await apiEcf('GET', `/api/v1/ecf/by-encf/${formatoNcf(tipo, ultimo + 1)}`)
        ultimo++
      } catch (e) {
        if (e.status !== 404) console.error('[secuencias]', e.message)
        break
      }
    }
  }
  return { ultimo, vencimiento: r?.vencimiento || null }
}

/** Sincroniza los rangos registrados con la plataforma y avisa a los administradores (una vez al día por rango). */
export async function revisarSecuencias() {
  if (!proveedorActivo()) return null
  const ambiente = await ambienteActual()
  if (!ambiente) return null
  for (const tipo of TIPOS_ECF) {
    const { ultimo, vencimiento } = await ultimoUsadoEnPlataforma(tipo, ambiente)
    if (ultimo !== null) await registrarUsoSecuencia(formatoNcf(tipo, ultimo), tipo, ambiente, vencimiento)
  }
  await exec(`UPDATE secuencias_ecf SET sincronizado = ${AHORA} WHERE ambiente = ?`, [ambiente])
  const alertas = await query(
    `SELECT id_secuencia, tipo_ecf, desde, hasta, ultimo_usado, COALESCE(vencimiento_informado, vencimiento) AS vence
       FROM secuencias_ecf
      WHERE ambiente = ? AND estado = 'Vigente' AND (ultima_alerta IS NULL OR ultima_alerta < ${HOY})
        AND ((hasta - ultimo_usado) < ? * (hasta - desde + 1) OR DATEDIFF(DAY, GETDATE(), COALESCE(vencimiento_informado, vencimiento)) < ?)`,
    [ambiente, ALERTA_PCT, ALERTA_DIAS])
  for (const a of alertas) {
    const quedan = a.hasta - a.ultimo_usado
    const dias = Math.ceil((new Date(a.vence) - Date.now()) / 86_400_000)
    await notificarAdmins({
      tipo: 'Factura', titulo: `Solicitar nueva secuencia ${a.tipo_ecf} (${NOMBRE_ECF[a.tipo_ecf]})`,
      mensaje: `${quedan <= 0 ? 'El rango está agotado' : `Quedan ${quedan} e-NCF`} (${formatoNcf(a.tipo_ecf, a.ultimo_usado)} de ${formatoNcf(a.tipo_ecf, a.hasta)})` +
        `${dias < ALERTA_DIAS ? ` y vence ${dias <= 0 ? 'hoy' : `en ${dias} días`}` : ''}. Solicítela en la Oficina Virtual de la DGII y cárguela en la plataforma e-CF.`,
    })
    await exec(`UPDATE secuencias_ecf SET ultima_alerta = ${HOY} WHERE id_secuencia = ?`, [a.id_secuencia])
  }
  return alertas.length
}

const SQL_SECUENCIA = `SELECT *, hasta - ultimo_usado AS disponibles, COALESCE(vencimiento_informado, vencimiento) AS vence,
            CASE WHEN COALESCE(vencimiento_informado, vencimiento) < CAST(GETDATE() AS date) THEN 'Vencida' WHEN ultimo_usado >= hasta THEN 'Agotada' ELSE estado END AS estado_actual,
            CASE WHEN (hasta - ultimo_usado) < ${ALERTA_PCT} * (hasta - desde + 1) OR DATEDIFF(DAY, GETDATE(), COALESCE(vencimiento_informado, vencimiento)) < ${ALERTA_DIAS} THEN 1 ELSE 0 END AS alerta
       FROM secuencias_ecf`

adminFacturacion.get('/secuencias', async (_req, res) => {
  if (!proveedorActivo()) return res.json(await query(`${SQL_SECUENCIA} WHERE ambiente IS NULL ORDER BY tipo_ecf, id_secuencia`))
  // Con plataforma: por tipo, el último e-NCF usado y el rango autorizado registrado (si lo hay)
  const ambiente = await ambienteActual()
  const rangos = ambiente ? await query(`${SQL_SECUENCIA} WHERE ambiente = ? ORDER BY tipo_ecf, desde`, [ambiente]) : []
  const usados = await query(
    `SELECT tipo_ecf, MAX(CAST(SUBSTRING(ncf, 4, 10) AS BIGINT)) AS ultimo, MAX(fecha_vencimiento_secuencia) AS vencimiento, COUNT(*) AS emitidos
       FROM ecf WHERE proveedor_id IS NOT NULL AND ambiente = ? GROUP BY tipo_ecf`, [ambiente])
  res.json({
    ambiente,
    tipos: TIPOS_ECF.map((tipo) => {
      const u = usados.find((x) => x.tipo_ecf === tipo)
      const propios = rangos.filter((r) => r.tipo_ecf === tipo)
      // Rango en uso: el vigente que contiene el último número; si no, el primero vigente
      const ultimo = Math.max(Number(u?.ultimo || 0), ...propios.map((r) => r.ultimo_usado))
      const actual = propios.find((r) => ultimo >= r.desde && ultimo <= r.hasta) || propios.find((r) => r.estado_actual === 'Vigente') || null
      return {
        tipo_ecf: tipo, nombre: NOMBRE_ECF[tipo], ultimo_ncf: ultimo ? formatoNcf(tipo, ultimo) : null, emitidos_sistema: u?.emitidos || 0,
        vencimiento_informado: actual?.vencimiento_informado || u?.vencimiento || null, rango: actual, otros_rangos: propios.filter((r) => r !== actual),
      }
    }),
  })
})

// Registrar un rango autorizado por la DGII (en modo plataforma, para monitorearlo; en simulado, para emitir)
adminFacturacion.post('/secuencias', async (req, res) => {
  const { tipo_ecf, desde, hasta, vencimiento } = req.body
  validar({
    tipo_ecf: !TIPOS_ECF.includes(tipo_ecf) && 'Tipo de e-CF inválido',
    rango: !(Number(desde) >= 1 && Number(hasta) >= Number(desde) && Number(hasta) <= 9999999999) && 'Rango de secuencia inválido',
    vencimiento: !/^\d{4}-\d{2}-\d{2}$/.test(vencimiento || '') && 'Indique la fecha de vencimiento',
  })
  const ambiente = proveedorActivo() ? await ambienteActual() : null
  if (proveedorActivo() && !ambiente) throw conflict('Emita al menos un comprobante con la plataforma para conocer su ambiente')
  const cruce = await one(
    `SELECT TOP 1 id_secuencia FROM secuencias_ecf WHERE tipo_ecf = ? AND ${ambiente ? 'ambiente = ?' : 'ambiente IS NULL'} AND desde <= ? AND hasta >= ?`,
    ambiente ? [tipo_ecf, ambiente, Number(hasta), Number(desde)] : [tipo_ecf, Number(hasta), Number(desde)])
  if (cruce) throw conflict('El rango se cruza con otro ya registrado para ese tipo')
  const x = await exec('INSERT INTO secuencias_ecf (tipo_ecf, desde, hasta, ultimo_usado, vencimiento, ambiente) VALUES (?, ?, ?, ?, ?, ?)',
    [tipo_ecf, Number(desde), Number(hasta), Number(desde) - 1, vencimiento, ambiente])
  await auditar(req, 'Secuencia e-NCF registrada', 'secuencias_ecf', x.insertId, null, { ...req.body, ambiente })
  if (ambiente) {
    // Toma el último número ya usado en la plataforma
    const { ultimo, vencimiento: informado } = await ultimoUsadoEnPlataforma(tipo_ecf, ambiente)
    if (ultimo !== null) await registrarUsoSecuencia(formatoNcf(tipo_ecf, ultimo), tipo_ecf, ambiente, informado)
    return res.status(201).json({ id_secuencia: x.insertId, ambiente })
  }
  // Modo simulado: emite e-NCF a los documentos que quedaron pendientes por falta de secuencia
  const pendientes = await query(`${SQL_SIN_ECF} ORDER BY f.id_factura`)
  for (const p of pendientes) await emitirDocumento(p.id_factura)
  res.status(201).json({ id_secuencia: x.insertId, facturas_regularizadas: pendientes.length })
})

// Corregir o retirar un rango mal registrado (no afecta los comprobantes ya emitidos)
adminFacturacion.delete('/secuencias/:id', async (req, res) => {
  const s = await one('SELECT * FROM secuencias_ecf WHERE id_secuencia = ?', [req.params.id])
  if (!s) throw notFound('Secuencia no encontrada')
  if (!s.ambiente && s.ultimo_usado >= s.desde) throw conflict('Esta secuencia local ya tiene números usados')
  await exec('DELETE FROM secuencias_ecf WHERE id_secuencia = ?', [s.id_secuencia])
  await auditar(req, 'Secuencia e-NCF eliminada', 'secuencias_ecf', s.id_secuencia, s, null)
  res.json({ ok: true })
})

adminFacturacion.post('/secuencias/sincronizar', async (_req, res) => {
  const avisos = await revisarSecuencias()
  res.json({ ok: true, avisos })
})

adminFacturacion.get('/comprobantes', async (req, res) => {
  const estado = req.query.estado
  const filas = await query(
    `SELECT TOP 500 e.id_ecf, e.ncf, e.tipo_ecf, e.track_id, e.estado_dgii, e.mensaje_dgii, e.fecha_envio, e.url_consulta, e.ambiente, e.proveedor_id,
            f.id_factura, f.numero_factura, f.tipo_documento, f.itbis, f.total, f.fecha_emision, f.estado AS estado_factura,
            eo.ncf AS origen_ncf, COALESCE(f.razon_social_comprador, c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente,
            COALESCE(f.rnc_comprador, c.rnc_cedula) AS rnc_cedula, c.id_cliente,
            IIF(f.tipo_documento = 'Nota de débito', f.total, f.total
              + (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de débito' AND n.estado = 'Emitida')
              - (SELECT COALESCE(SUM(n.total), 0) FROM facturas n WHERE n.id_factura_origen = f.id_factura AND n.tipo_documento = 'Nota de crédito'
                  AND n.estado = 'Emitida' AND n.id_nota_revertida IS NULL)) AS disponible_credito
       FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura JOIN clientes c ON c.id_cliente = f.id_cliente
       JOIN usuarios u ON u.id_usuario = c.id_usuario LEFT JOIN ecf eo ON eo.id_factura = f.id_factura_origen
      ${estado ? (estado === 'Aceptado' ? "WHERE e.estado_dgii LIKE 'Aceptado%'" : 'WHERE e.estado_dgii = ?') : ''}
      ORDER BY e.id_ecf DESC`,
    estado && estado !== 'Aceptado' ? [estado] : [])
  const sinEcf = await query(`${SQL_SIN_ECF} ORDER BY f.id_factura`)
  res.json({
    comprobantes: filas.map((x) => ({
      ...x, nombre_ecf: NOMBRE_ECF[x.tipo_ecf],
      puede_nota_credito: x.tipo_documento !== 'Nota de crédito' && x.estado_factura === 'Emitida' && x.estado_dgii.startsWith('Aceptado') &&
        x.disponible_credito > 0 && (!proveedorActivo() || !!x.proveedor_id),
    })),
    pendientes_encf: sinEcf,
  })
})

adminFacturacion.post('/ecf/:id/consultar', async (req, res) => {
  await enviarDgii(Number(req.params.id))
  res.json(await one('SELECT ncf, track_id, estado_dgii, mensaje_dgii FROM ecf WHERE id_ecf = ?', [req.params.id]))
})

// Reintentar la emisión de un documento que no obtuvo e-CF (error de comunicación o falta de secuencia)
adminFacturacion.post('/facturas/:id/emitir', async (req, res) => {
  const id_ecf = await emitirDocumento(Number(req.params.id))
  const f = await one('SELECT numero_factura, error_ecf FROM facturas WHERE id_factura = ?', [req.params.id])
  if (!id_ecf) throw badRequest(f?.error_ecf || 'No se pudo emitir el e-CF')
  res.json(await one('SELECT ncf, track_id, estado_dgii, mensaje_dgii FROM ecf WHERE id_ecf = ?', [id_ecf]))
})

// FAC-P04 · Solicitudes de nota de crédito de los clientes
adminFacturacion.get('/solicitudes-nota-credito', async (req, res) => {
  const estado = req.query.estado || 'Pendiente'
  const filas = await query(
    `SELECT TOP 300 x.*, f.numero_factura, f.tipo_documento, f.total, f.fecha_emision, f.estado AS estado_factura, e.ncf, e.tipo_ecf,
            ${SQL_DISPONIBLE} AS disponible_credito, COALESCE(f.razon_social_comprador, c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente,
            u.email, p.metodo_pago, p.estado AS estado_pago, s.codigo_seguimiento AS solicitud, n.numero_factura AS nota_numero, en.ncf AS nota_ncf,
            en.estado_dgii AS nota_estado_dgii, CONCAT(ua.nombre, ' ', ua.apellido) AS respondido_por_nombre
       FROM solicitudes_nota_credito x JOIN facturas f ON f.id_factura = x.id_factura LEFT JOIN ecf e ON e.id_factura = f.id_factura
       JOIN clientes c ON c.id_cliente = x.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
       ${SQL_PAGO_DOC} LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       LEFT JOIN facturas n ON n.id_factura = x.id_nota LEFT JOIN ecf en ON en.id_factura = n.id_factura
       LEFT JOIN usuarios ua ON ua.id_usuario = x.respondido_por
      ${estado === 'Todas' ? '' : estado === 'Por devolver' ? "WHERE x.estado = 'Aprobada' AND x.requiere_devolucion = 1 AND x.fecha_devolucion IS NULL" : 'WHERE x.estado = ?'}
      ORDER BY x.id_solicitud_nc DESC`,
    ['Todas', 'Por devolver'].includes(estado) ? [] : [estado])
  const conteo = await one(
    `SELECT SUM(IIF(estado = 'Pendiente', 1, 0)) AS pendientes,
            SUM(IIF(estado = 'Aprobada' AND requiere_devolucion = 1 AND fecha_devolucion IS NULL, 1, 0)) AS por_devolver
       FROM solicitudes_nota_credito`)
  res.json({ solicitudes: filas, pendientes: conteo.pendientes || 0, por_devolver: conteo.por_devolver || 0 })
})

/**
 * Aprobar: emite la nota de crédito (total o parcial; el administrador puede ajustar el monto) y avisa al cliente.
 * Si el documento se pagó, queda marcada la devolución del dinero. Rechazar: requiere la respuesta al cliente.
 */
adminFacturacion.post('/solicitudes-nota-credito/:id/responder', async (req, res) => {
  const decision = req.body.decision
  const respuesta = String(req.body.respuesta || '').trim().slice(0, 300)
  if (!['Aprobar', 'Rechazar'].includes(decision)) throw badRequest('Decisión inválida')
  if (decision === 'Rechazar' && !respuesta) throw badRequest('Explique al cliente por qué se rechaza')
  const out = await transaction(async (cx) => {
    const x = await one(
      `SELECT x.*, f.numero_factura, f.id_pago, c.id_usuario FROM solicitudes_nota_credito x WITH (UPDLOCK, ROWLOCK)
         JOIN facturas f ON f.id_factura = x.id_factura JOIN clientes c ON c.id_cliente = x.id_cliente WHERE x.id_solicitud_nc = ?`,
      [req.params.id], cx)
    if (!x) throw notFound('Solicitud no encontrada')
    if (x.estado !== 'Pendiente') throw conflict(`La solicitud ya está ${x.estado.toLowerCase()}`)
    if (decision === 'Rechazar') {
      await exec(`UPDATE solicitudes_nota_credito SET estado = 'Rechazada', fecha_respuesta = ${AHORA}, respondido_por = ?, respuesta = ? WHERE id_solicitud_nc = ?`,
        [req.usuario.id_usuario, respuesta, x.id_solicitud_nc], cx)
      await notificar(x.id_usuario, { tipo: 'Factura', titulo: `Solicitud de nota de crédito rechazada · ${x.numero_factura}`, mensaje: respuesta, canales: ['App', 'Correo'] }, cx)
      await auditar(req, 'Solicitud de nota de crédito rechazada', 'solicitudes_nota_credito', x.id_solicitud_nc, { estado: 'Pendiente' }, { estado: 'Rechazada', respuesta }, cx)
      return { estado: 'Rechazada' }
    }
    // El administrador puede aprobar por otro tipo o monto
    const tipo = req.body.tipo || x.tipo
    const monto = tipo === 'Parcial' ? Number(String(req.body.monto ?? x.monto ?? '').replace(/,/g, '')) : null
    if (tipo === 'Parcial' && !(monto > 0)) throw badRequest('Indique el monto a acreditar')
    const nota = await crearNotaCredito(cx, { id_factura: x.id_factura, razon: `${x.motivo}: ${x.detalle}`.slice(0, 90), monto })
    // Hubo dinero de por medio si el documento (o el que modifica) tiene un pago confirmado
    const pago = await one(
      `SELECT TOP 1 p.estado FROM facturas f LEFT JOIN facturas fo ON fo.id_factura = f.id_factura_origen
         JOIN pagos p ON p.id_pago = COALESCE(f.id_pago, fo.id_pago) WHERE f.id_factura = ?`, [x.id_factura], cx)
    const devolver = pago?.estado === 'Confirmado' ? 1 : 0
    await exec(
      `UPDATE solicitudes_nota_credito SET estado = 'Aprobada', fecha_respuesta = ${AHORA}, respondido_por = ?, respuesta = ?, id_nota = ?,
              monto_acreditado = ?, requiere_devolucion = ?, tipo = ?, monto = ? WHERE id_solicitud_nc = ?`,
      [req.usuario.id_usuario, respuesta || null, nota.id_factura, nota.total, devolver, tipo, monto, x.id_solicitud_nc], cx)
    await notificar(x.id_usuario, {
      tipo: 'Factura', titulo: `Nota de crédito aprobada · ${x.numero_factura}`,
      mensaje: `Se emitió la nota de crédito ${nota.numero} por RD$ ${Number(nota.total).toFixed(2)}.${devolver ? ' Te contactaremos para la devolución del dinero.' : ''}${respuesta ? ` ${respuesta}` : ''}`,
      canales: ['App', 'Correo'],
    }, cx)
    await auditar(req, 'Solicitud de nota de crédito aprobada', 'solicitudes_nota_credito', x.id_solicitud_nc, { estado: 'Pendiente' },
      { estado: 'Aprobada', nota: nota.numero, total: nota.total }, cx)
    return { estado: 'Aprobada', id_nota: nota.id_factura, nota: nota.numero, requiere_devolucion: !!devolver }
  })
  if (out.id_nota) {
    await emitirDocumento(out.id_nota)
    const e = await one('SELECT e.ncf, e.estado_dgii, f.error_ecf FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?', [out.id_nota])
    Object.assign(out, e)
  }
  res.json(out)
})

// Registrar que el dinero ya se devolvió al cliente (PayPal, tarjeta, transferencia o efectivo)
adminFacturacion.post('/solicitudes-nota-credito/:id/devuelto', async (req, res) => {
  const referencia = String(req.body.referencia || '').trim().slice(0, 60)
  if (!referencia) throw badRequest('Indique la referencia de la devolución')
  await transaction(async (cx) => {
    const x = await one(
      `SELECT x.*, f.numero_factura, c.id_usuario FROM solicitudes_nota_credito x JOIN facturas f ON f.id_factura = x.id_factura
         JOIN clientes c ON c.id_cliente = x.id_cliente WHERE x.id_solicitud_nc = ?`, [req.params.id], cx)
    if (!x) throw notFound('Solicitud no encontrada')
    if (x.estado !== 'Aprobada' || !x.requiere_devolucion || x.fecha_devolucion) throw conflict('Esta solicitud no tiene una devolución pendiente')
    await exec(`UPDATE solicitudes_nota_credito SET fecha_devolucion = ${AHORA}, referencia_devolucion = ? WHERE id_solicitud_nc = ?`, [referencia, x.id_solicitud_nc], cx)
    await notificar(x.id_usuario, {
      tipo: 'Pago', titulo: `Devolución realizada · ${x.numero_factura}`,
      mensaje: `Te devolvimos RD$ ${Number(x.monto_acreditado).toFixed(2)} (referencia ${referencia}).`, canales: ['App', 'Correo'],
    }, cx)
    await auditar(req, 'Devolución de nota de crédito', 'solicitudes_nota_credito', x.id_solicitud_nc, null, { referencia, monto: x.monto_acreditado }, cx)
  })
  res.json({ ok: true })
})

// En lugar de devolver el dinero: voucher (saldo a favor) por el monto de la nota de crédito
adminFacturacion.post('/solicitudes-nota-credito/:id/voucher', async (req, res) => {
  const v = await transaction(async (cx) => {
    const x = await one(
      `SELECT x.*, f.numero_factura, c.id_usuario FROM solicitudes_nota_credito x WITH (UPDLOCK, ROWLOCK) JOIN facturas f ON f.id_factura = x.id_factura
         JOIN clientes c ON c.id_cliente = x.id_cliente WHERE x.id_solicitud_nc = ?`, [req.params.id], cx)
    if (!x) throw notFound('Solicitud no encontrada')
    if (x.estado !== 'Aprobada' || !x.requiere_devolucion || x.fecha_devolucion) throw conflict('Esta solicitud no tiene una devolución pendiente')
    const voucher = await crearVoucher(cx, {
      id_cliente: x.id_cliente, monto: x.monto_acreditado, origen: 'Nota de crédito', id_solicitud_nc: x.id_solicitud_nc, id_nota: x.id_nota, creado_por: req.usuario.id_usuario,
    })
    await exec(`UPDATE solicitudes_nota_credito SET fecha_devolucion = ${AHORA}, referencia_devolucion = ? WHERE id_solicitud_nc = ?`, [voucher.codigo, x.id_solicitud_nc], cx)
    await notificar(x.id_usuario, {
      tipo: 'Pago', titulo: `Tienes un voucher de RD$ ${Number(x.monto_acreditado).toFixed(2)}`,
      mensaje: `Por la nota de crédito de ${x.numero_factura} te emitimos el voucher ${voucher.codigo}. Úsalo como forma de pago en tu próximo servicio.`, canales: ['App', 'Correo'],
    }, cx)
    await auditar(req, 'Voucher por nota de crédito', 'solicitudes_nota_credito', x.id_solicitud_nc, null, { voucher: voucher.codigo, monto: x.monto_acreditado }, cx)
    return voucher
  })
  res.status(201).json(v)
})

// FAC-P04 · Nota de crédito manual: total (anula) o parcial (corrige montos), con motivo
adminFacturacion.post('/facturas/:id/nota-credito', async (req, res) => {
  const razon = String(req.body.razon || '').trim()
  const parcial = req.body.tipo === 'Parcial'
  const monto = parcial ? Number(String(req.body.monto || '').replace(/,/g, '')) : null
  validar({
    razon: !razon && 'Indique el motivo de la nota de crédito',
    monto: parcial && !(monto > 0) && 'Indique el monto a acreditar (con ITBIS)',
  })
  const nota = await transaction(async (cx) => {
    const n = await crearNotaCredito(cx, { id_factura: Number(req.params.id), razon, monto })
    await auditar(req, 'Nota de crédito emitida', 'facturas', n.origen.id_factura, { numero: n.origen.numero_factura, total: n.origen.total },
      { nota: n.numero, total: n.total, razon }, cx)
    return n
  })
  await emitirDocumento(nota.id_factura)
  res.status(201).json(await one(
    `SELECT f.numero_factura, f.total, f.codigo_modificacion, f.error_ecf, e.ncf, e.estado_dgii, e.mensaje_dgii
       FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura WHERE f.id_factura = ?`, [nota.id_factura]))
})

// Corregir y reenviar: actualiza el dato del comprador, conserva el XML original para auditoría
adminFacturacion.post('/ecf/:id/reenviar', async (req, res) => {
  const e = await one(
    'SELECT e.*, f.id_cliente FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura WHERE e.id_ecf = ?', [req.params.id])
  if (!e) throw notFound('Comprobante no encontrado')
  if (e.estado_dgii !== 'Rechazado') throw conflict('Solo se reenvían comprobantes rechazados')
  const doc = String(req.body.rnc_cedula || '').replace(/\D/g, '')
  if (doc) {
    if (e.tipo_ecf === 'e31' ? !rncValido(doc) : !(cedulaValida(doc) || rncValido(doc))) throw badRequest('Cédula/RNC inválido')
    await exec('UPDATE clientes SET rnc_cedula = ?, razon_social = COALESCE(?, razon_social) WHERE id_cliente = ?', [doc, req.body.razon_social || null, e.id_cliente])
    await exec('UPDATE facturas SET rnc_comprador = ?, razon_social_comprador = COALESCE(?, razon_social_comprador) WHERE id_factura = ?',
      [doc, req.body.razon_social || null, e.id_factura])
  }
  if (e.proveedor_id) {
    await auditar(req, 'e-CF corregido y reenviado', 'ecf', e.id_ecf, { ncf: e.ncf, estado_dgii: 'Rechazado' }, { rnc_cedula: doc || null })
    const id_ecf = await emitirConProveedor(e.id_factura)
    if (!id_ecf) throw badRequest((await one('SELECT error_ecf FROM facturas WHERE id_factura = ?', [e.id_factura]))?.error_ecf || 'No se pudo reenviar')
    return res.json(await one('SELECT ncf, track_id, estado_dgii, mensaje_dgii FROM ecf WHERE id_ecf = ?', [id_ecf]))
  }
  const actual = path.join(DIR_ECF, path.basename(e.xml_url))
  const original = actual.replace(/\.xml$/, `.rechazado-${Date.now()}.xml`)
  await fs.copyFile(actual, original).catch(() => {})
  const xml = await fs.readFile(actual, 'utf8').catch(() => null)
  if (xml && doc) await fs.writeFile(actual, xml.replace(/<RNCComprador>[^<]*<\/RNCComprador>/, `<RNCComprador>${doc}</RNCComprador>`), 'utf8')
  await exec("UPDATE ecf SET estado_dgii = 'En proceso', mensaje_dgii = NULL WHERE id_ecf = ?", [e.id_ecf])
  await auditar(req, 'e-CF corregido y reenviado', 'ecf', e.id_ecf, { estado_dgii: 'Rechazado' }, { rnc_cedula: doc || null })
  await enviarDgii(e.id_ecf)
  res.json(await one('SELECT ncf, track_id, estado_dgii, mensaje_dgii FROM ecf WHERE id_ecf = ?', [e.id_ecf]))
})

// 31.7 · Reporte de comprobantes emitidos (base para formato 607), CSV para Excel. Las notas indican el NCF que modifican.
adminFacturacion.get('/607', async (req, res) => {
  const desde = req.query.desde || '1900-01-01', hasta = req.query.hasta || '2999-12-31'
  const filas = await query(
    `SELECT e.ncf, e.tipo_ecf, eo.ncf AS ncf_modificado, CONVERT(char(10), f.fecha_emision, 23) AS fecha,
            COALESCE(f.rnc_comprador, c.rnc_cedula) AS rnc_cedula, f.subtotal - f.descuento AS monto_facturado, f.itbis, e.estado_dgii
       FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura JOIN clientes c ON c.id_cliente = f.id_cliente
       LEFT JOIN ecf eo ON eo.id_factura = f.id_factura_origen
      WHERE CAST(f.fecha_emision AS date) BETWEEN ? AND ? ORDER BY e.ncf`,
    [desde, hasta])
  const csv = ['e-NCF,Tipo,NCF modificado,Fecha,RNC/Cédula comprador,Monto facturado,ITBIS,Estado DGII',
    ...filas.map((x) => [x.ncf, x.tipo_ecf, x.ncf_modificado || '', x.fecha, x.rnc_cedula || '', x.monto_facturado.toFixed(2), x.itbis.toFixed(2), x.estado_dgii].join(','))].join('\r\n')
  res.type('text/csv; charset=utf-8').attachment(`607_${desde}_${hasta}.csv`).send(`\uFEFF${csv}`)
})

// ---------- Consulta pública de contribuyente (registro de clientes, sin sesión) ----------
// Límite por IP para que no se use como buscador masivo del padrón de la DGII
const CONSULTAS_POR_MINUTO = 15
const consultasPorIp = new Map()
function limiteConsultas(req, _res, next) {
  const ahora = Date.now()
  const lista = (consultasPorIp.get(req.ip) || []).filter((t) => ahora - t < 60_000)
  if (lista.length >= CONSULTAS_POR_MINUTO) return next(new HttpError(429, 'Demasiadas consultas de RNC; espere un minuto'))
  lista.push(ahora)
  consultasPorIp.set(req.ip, lista)
  if (consultasPorIp.size > 5000) consultasPorIp.clear()
  next()
}

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.get('/contribuyentes/:valor', limiteConsultas, async (req, res) => {
  const r = await consultarContribuyente(req.params.valor)
  // Solo lo necesario para el formulario (nombre y estado públicos del padrón)
  res.json({ valido: r.valido, documento: r.documento, verificado: !!r.verificado, nombre: r.nombre || null, estado: r.estado || null, motivo: r.motivo || null })
})
router.use('/facturas', rFacturas)
router.use('/admin/facturacion', adminFacturacion)
