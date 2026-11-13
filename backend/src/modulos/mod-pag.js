// =====================================================================
// MOD-PAG · Gestión de Pagos (proceso 3.0)
// PAG-P01 Checkout · PAG-P02 PayPal · PAG-P03 Tarjeta · PAG-P04 Transferencia · PAG-P05 Efectivo · PAG-P06 Conciliación · PAG-P07 Webhooks PayPal
// =====================================================================
import crypto from 'node:crypto'
import { Router } from 'express'
import { exec, one, query, transaction, AHORA } from '../config/db.js'
import { autenticar, soloRol } from '../middleware/auth.js'
import { badRequest, conflict, forbidden, notFound, validar } from '../lib/http.js'
import { round2, tipoEcf } from '../lib/fiscal.js'
import { upload, urlArchivo } from '../lib/upload.js'
import { lineasCobro, estadoCobro, facturaDelServicio, SQL_DOCUMENTO_PAGO } from '../lib/totales.js'
import { movimientosDePago, reversarPago, movimientoLiquidacion, saldoPrestador, planPrestador, comisionPctDe, ajustesCobro, guardarAjustesCobro } from '../lib/comisiones.js'
import { generarFactura, notasCreditoDePago, emitirDocumento, consultarContribuyente } from './mod-fac.js'
import { crearVoucher, voucherDelCliente, vouchersDelCliente } from '../lib/vouchers.js'
import { auditar, notificar, notificarAdmins } from './mod-adm.js'

// PAG-P02 / PAG-P07 · PayPal Orders API v2.
// Sin PAYPAL_CLIENT_ID funciona en modo simulado para desarrollo.
const BASE = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
export const paypalSimulado = () => !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET

async function token() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) throw new Error(`PayPal auth ${r.status}`)
  return (await r.json()).access_token
}

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(`PayPal ${r.status}: ${data.details?.[0]?.issue || data.name || 'error'} — ${data.details?.[0]?.description || data.message || ''}`)
    e.issue = data.details?.[0]?.issue || data.name
    throw e
  }
  return data
}

/** Crea la orden en USD (PayPal no opera en RD$). */
/**
 * Crea la orden en USD y devuelve la URL donde el cliente aprueba el pago.
 * PayPal regresa al cliente a returnUrl (agrega ?token=ORDER_ID) o a cancelUrl si cancela.
 */
export async function crearOrden({ montoUsd, referencia, descripcion, returnUrl, cancelUrl }) {
  if (paypalSimulado()) {
    const id = `SIM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    return { id, status: 'CREATED', aprobarUrl: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}token=${id}` }
  }
  const d = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: referencia, description: descripcion, amount: { currency_code: 'USD', value: montoUsd.toFixed(2) } }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Directorio Servicios',
          locale: 'es-DO',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  })
  const enlace = d.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
  return { id: d.id, status: d.status, aprobarUrl: enlace?.href }
}

/** Captura la orden aprobada por el cliente. */
export async function capturarOrden(orderId) {
  if (paypalSimulado()) return { status: 'COMPLETED', captureId: `${crypto.randomBytes(5).toString('hex').toUpperCase()}XY` }
  let d
  try {
    d = await api('POST', `/v2/checkout/orders/${orderId}/capture`)
  } catch (e) {
    if (e.issue !== 'ORDER_ALREADY_CAPTURED') throw e
    d = await api('GET', `/v2/checkout/orders/${orderId}`) // ya capturada (p. ej. doble clic): se usa la captura existente
  }
  const cap = d.purchase_units?.[0]?.payments?.captures?.[0]
  return { status: d.status === 'COMPLETED' && cap?.status === 'COMPLETED' ? 'COMPLETED' : 'DECLINED', captureId: cap?.id || null }
}

/** Verifica la firma del webhook con la API de PayPal. */
export async function verificarWebhook(headers, evento) {
  if (paypalSimulado()) return true
  const d = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: evento,
  })
  return d.verification_status === 'SUCCESS'
}

const rPagos = Router()
const TASA = () => Number(process.env.TASA_USD || 61)
const codigoPago = (id) => `PAG-${String(id).padStart(4, '0')}`
const CONCEPTO = { Total: 'Pago', Anticipo: 'Anticipo (50 %)', Saldo: 'Saldo (50 %)', Cargo: 'Cargo adicional', Suscripcion: 'Pago del plan' }

/**
 * Subproceso 3.5 · Confirmar pago: estado Confirmado, recibo al cliente y
 * dispara automáticamente el proceso 4.0 Generar factura.
 */
export async function confirmarPago(id_pago, { confirmado_por = null, referencia = null } = {}) {
  const ok = await transaction(async (cx) => {
    const p = await one('SELECT * FROM pagos WITH (UPDLOCK, ROWLOCK) WHERE id_pago = ?', [id_pago], cx)
    if (!p || p.estado === 'Confirmado') return false
    if (p.id_solicitud) {
      // Un solo pago confirmado por concepto (cada cargo adicional es un concepto distinto)
      const otro = await one(
        "SELECT id_pago FROM pagos WHERE id_solicitud = ? AND tipo_pago = ? AND (id_cargo = ? OR ? IS NULL) AND estado = 'Confirmado' AND id_pago <> ?",
        [p.id_solicitud, p.tipo_pago, p.id_cargo, p.id_cargo, id_pago], cx)
      if (otro) throw conflict(`La solicitud ya tiene un ${p.tipo_pago === 'Total' ? 'pago' : CONCEPTO[p.tipo_pago].toLowerCase()} confirmado`)
    }
    await exec(
      `UPDATE pagos SET estado = 'Confirmado', fecha_pago = ${AHORA}, confirmado_por = COALESCE(?, confirmado_por),
              referencia = COALESCE(?, referencia) WHERE id_pago = ?`,
      [confirmado_por, referencia, id_pago], cx,
    )
    // Estado de cuenta del prestador: lo que gana con este pago, comisión de extras y efectivo en mano
    await movimientosDePago(cx, p)
    // Pago de un plan: la suscripción queda Activa desde hoy por su periodicidad
    if (p.id_suscripcion) {
      // Cambio de plan: el plan anterior (activo o cancelado aún vigente) termina al activarse el nuevo
      await exec(
        `UPDATE suscripciones SET estado = 'Vencida' WHERE id_cliente = ? AND id_suscripcion <> ? AND estado IN ('Activa', 'Cancelada')
            AND fecha_renovacion >= CAST(GETDATE() AS date)`, [p.id_cliente, p.id_suscripcion], cx)
      await exec(
        `UPDATE s SET estado = 'Activa', fecha_inicio = CAST(GETDATE() AS date),
                fecha_renovacion = DATEADD(MONTH, CASE pl.periodicidad WHEN 'Anual' THEN 12 WHEN 'Trimestral' THEN 3 ELSE 1 END, CAST(GETDATE() AS date))
           FROM suscripciones s JOIN planes pl ON pl.id_plan = s.id_plan WHERE s.id_suscripcion = ? AND s.estado = 'Pendiente'`,
        [p.id_suscripcion], cx)
    }
    const c = await one('SELECT id_usuario FROM clientes WHERE id_cliente = ?', [p.id_cliente], cx)
    const concepto = p.id_suscripcion ? CONCEPTO.Suscripcion : CONCEPTO[p.tipo_pago] || 'Pago'
    // El saldo se abona a la factura del servicio emitida con el anticipo
    const servicio = p.tipo_pago === 'Saldo' ? await facturaDelServicio(p.id_solicitud, cx) : null
    const documento = servicio ? `Se abonó a tu factura ${servicio.numero_factura}, que queda pagada.`
      : `${p.tipo_pago === 'Cargo' ? 'Tu nota de débito electrónica' : 'Tu factura electrónica'} se está emitiendo.`
    await notificar(c.id_usuario, {
      tipo: 'Pago', titulo: `${concepto} ${codigoPago(id_pago)} confirmado`,
      mensaje: `Recibimos tu pago de RD$ ${Number(p.monto).toFixed(2)} (${p.metodo_pago}). ${documento}${p.tipo_pago === 'Anticipo' ? ' Es el primer abono a la factura del servicio; el saldo se paga al finalizar.' : ''}`,
      canales: ['App', 'Correo'],
    }, cx)
    if (['Anticipo', 'Cargo'].includes(p.tipo_pago) && p.id_solicitud) {
      const pr = await one(
        `SELECT TOP 1 e.id_usuario, s.codigo_seguimiento FROM asignaciones_servicio a JOIN empleados e ON e.id_empleado = a.id_empleado
           JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
          WHERE a.id_solicitud = ? AND a.estado_asignacion IN ('Aceptada','Completada') ORDER BY a.id_asignacion DESC`, [p.id_solicitud], cx)
      if (pr) {
        await notificar(pr.id_usuario, p.tipo_pago === 'Anticipo'
          ? { tipo: 'Pago', titulo: `Anticipo recibido · ${pr.codigo_seguimiento}`, mensaje: 'El cliente pagó el 50 % de anticipo. Puedes realizar el servicio.', canales: ['App', 'WhatsApp'] }
          : { tipo: 'Pago', titulo: `Cargo adicional pagado · ${pr.codigo_seguimiento}`, mensaje: `El cliente pagó el cargo adicional de RD$ ${Number(p.monto).toFixed(2)}.`, canales: ['App', 'WhatsApp'] }, cx)
      }
    }
    return true
  })
  if (ok) await generarFactura(id_pago)
  return ok
}

async function rechazarPago(id_pago, motivo, cx) {
  await exec("UPDATE pagos SET estado = 'Rechazado', observacion = ? WHERE id_pago = ?", [motivo?.slice(0, 200) || null, id_pago], cx)
  const p = await one('SELECT p.*, c.id_usuario FROM pagos p JOIN clientes c ON c.id_cliente = p.id_cliente WHERE p.id_pago = ?', [id_pago], cx)
  await notificar(p.id_usuario, {
    tipo: 'Pago', titulo: `Pago ${codigoPago(id_pago)} rechazado`,
    mensaje: `${motivo || 'El pago no pudo completarse.'} Puedes intentarlo de nuevo con otro método.`, canales: ['App', 'Correo'],
  }, cx)
}

/**
 * Solicitud que se puede cobrar ahora y qué cobro corresponde:
 * Anticipo (50 %) con la solicitud En proceso, Saldo (50 %) al quedar Completado.
 */
async function solicitudPagable(codigo, id_cliente, cx) {
  const s = await one('SELECT * FROM solicitudes_servicio WHERE codigo_seguimiento = ?', [codigo], cx)
  if (!s) throw notFound('Solicitud no encontrada')
  if (id_cliente && s.id_cliente !== id_cliente) throw forbidden()
  const cobro = await estadoCobro(s.id_solicitud, cx)
  if (!cobro.siguiente) throw conflict(cobro.motivo || 'Esta solicitud no tiene pagos pendientes')
  return { ...s, tipo_pago: cobro.siguiente, id_cargo: cobro.id_cargo ?? null, cobro }
}

// ---------- PAG-P01 · Checkout ----------
rPagos.get('/checkout/:codigo', autenticar, soloRol('Cliente'), async (req, res) => {
  const s = await solicitudPagable(req.params.codigo, req.usuario.id_cliente)
  const t = await lineasCobro(s.id_solicitud, s.tipo_pago, undefined, s.id_cargo)
  const cliente = await one('SELECT tipo_cliente, rnc_cedula, razon_social FROM clientes WHERE id_cliente = ?', [req.usuario.id_cliente])
  res.json({
    codigo: s.codigo_seguimiento, fecha_completado: s.fecha_finalizacion, estado_solicitud: s.estado,
    tipo_pago: s.tipo_pago, total_servicio: s.cobro.total_servicio,
    cargo: t.cargo ? { descripcion: t.cargo.descripcion, motivo: t.cargo.motivo } : null,
    anticipo_pagado: s.cobro.anticipo ? { monto: s.cobro.anticipo.monto, estado: s.cobro.anticipo.estado, numero_factura: s.cobro.anticipo.numero_factura } : null,
    lineas: t.detalle.map((l) => ({ descripcion: l.nombre, cantidad: l.cantidad, precio: Number(l.precio_unitario), importe: Number(l.subtotal), descuento: l.descuento_linea })),
    subtotal: t.subtotal, descuento: t.descuento, itbis: t.itbis, total: t.total, plan: t.plan,
    tipo_ecf: s.tipo_pago === 'Cargo' ? 'e33' : s.comprobante_tipo || tipoEcf(cliente), cliente,
    comprobante: s.comprobante_tipo ? { tipo: s.comprobante_tipo, rnc: s.comprobante_rnc, razon_social: s.comprobante_razon } : null,
    // Ya hay facturas de esta solicitud: el comprobante elegido aplica a los cobros siguientes
    facturas_previas: s.cobro.pagos.filter((p) => p.numero_factura).length, tasa_usd: TASA(), total_usd: round2(t.total / TASA()),
    paypal_simulado: paypalSimulado(),
    cubierto_por_plan: t.total === 0,
  })
})

/**
 * PAG-P01 · El cliente elige el comprobante fiscal: consumo (e32) o crédito fiscal (e31) con RNC/cédula validado en la DGII.
 * Se guarda en la solicitud y aplica a los cobros siguientes (anticipo, saldo), también si se paga en efectivo.
 */
rPagos.put('/comprobante/:codigo', autenticar, soloRol('Cliente'), async (req, res) => {
  const s = await one('SELECT id_solicitud, id_cliente FROM solicitudes_servicio WHERE codigo_seguimiento = ?', [req.params.codigo])
  if (!s) throw notFound('Solicitud no encontrada')
  if (s.id_cliente !== req.usuario.id_cliente) throw forbidden()
  const tipo = req.body.tipo
  if (!['e31', 'e32'].includes(tipo)) throw badRequest('Seleccione el tipo de comprobante')
  if (tipo === 'e32') {
    await exec('UPDATE solicitudes_servicio SET comprobante_tipo = ?, comprobante_rnc = NULL, comprobante_razon = NULL WHERE id_solicitud = ?', ['e32', s.id_solicitud])
    return res.json({ tipo })
  }
  const c = await consultarContribuyente(req.body.rnc)
  if (!c.valido) throw badRequest(c.motivo)
  const razon = (c.nombre || String(req.body.razon_social || '').trim()).slice(0, 150)
  if (!razon) throw badRequest('Indique la razón social', { razon_social: 'Indique la razón social' })
  await exec('UPDATE solicitudes_servicio SET comprobante_tipo = ?, comprobante_rnc = ?, comprobante_razon = ? WHERE id_solicitud = ?',
    ['e31', c.documento, razon, s.id_solicitud])
  // Se guarda en el perfil si el cliente aún no tenía RNC/cédula
  await exec(`UPDATE clientes SET rnc_cedula = COALESCE(NULLIF(rnc_cedula, ''), ?), razon_social = COALESCE(NULLIF(razon_social, ''), ?) WHERE id_cliente = ?`,
    [c.documento, razon, s.id_cliente])
  res.json({ tipo, rnc: c.documento, razon_social: razon, verificado: !!c.verificado })
})

// Crea el registro en pagos (Pendiente) con el método elegido (v_metodoPagoTemp)
// ---------- Voucher (saldo a favor): cuánto cubre del cobro actual ----------
rPagos.get('/voucher/:voucher', autenticar, soloRol('Cliente'), async (req, res) => {
  const v = await voucherDelCliente(req.params.voucher, req.usuario.id_cliente)
  const s = await solicitudPagable(req.query.solicitud, req.usuario.id_cliente)
  const t = await lineasCobro(s.id_solicitud, s.tipo_pago, undefined, s.id_cargo)
  const aplicado = round2(Math.min(v.saldo, t.total))
  res.json({ codigo: v.codigo, saldo: v.saldo, aplicado, resto: round2(t.total - aplicado), saldo_despues: round2(v.saldo - aplicado) })
})

rPagos.get('/vouchers/mios', autenticar, soloRol('Cliente'), async (req, res) => {
  res.json((await vouchersDelCliente(req.usuario.id_cliente)).map((v) => ({ ...v, saldo: round2(v.saldo) })))
})

/**
 * Crea el pago (Pendiente) con el método elegido (v_metodoPagoTemp). Con voucher: se aplica su saldo hasta el total;
 * si lo cubre todo, el método es Voucher y el pago se confirma de inmediato; si no, el resto se paga con el método elegido.
 */
rPagos.post('/', autenticar, soloRol('Cliente'), async (req, res) => {
  const metodo = req.body.metodo_pago
  validar({
    metodo_pago: !['PayPal', 'Tarjeta', 'Transferencia', 'Voucher'].includes(metodo) && 'Seleccione un método de pago',
    voucher: metodo === 'Voucher' && !req.body.voucher && 'Indique el número del voucher',
  })
  const out = await transaction(async (cx) => {
    const s = await solicitudPagable(req.body.codigo, req.usuario.id_cliente, cx)
    const t = await lineasCobro(s.id_solicitud, s.tipo_pago, cx, s.id_cargo) // v_totalPagar del anticipo, saldo o cargo, recalculado en el servidor
    if (t.total <= 0) throw conflict('Este cobro no tiene monto pendiente')
    // Un intento anterior se descarta (y libera el voucher que tuviera aplicado)
    await exec("UPDATE pagos SET estado = 'Rechazado', observacion = 'Reemplazado por un nuevo intento' WHERE id_solicitud = ? AND estado = 'Pendiente'", [s.id_solicitud], cx)
    const v = req.body.voucher ? await voucherDelCliente(req.body.voucher, req.usuario.id_cliente, cx) : null
    const aplicado = v ? round2(Math.min(v.saldo, t.total)) : 0
    const resto = round2(t.total - aplicado)
    if (metodo === 'Voucher' && resto > 0) throw conflict(`El voucher cubre ${aplicado.toFixed(2)}; elige cómo pagar los RD$ ${resto.toFixed(2)} restantes`)
    const p = await exec(
      "INSERT INTO pagos (id_cliente, id_solicitud, monto, metodo_pago, tipo_pago, id_cargo, id_voucher, monto_voucher, referencia, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente')",
      [req.usuario.id_cliente, s.id_solicitud, t.total, metodo, s.tipo_pago, s.id_cargo, v?.id_voucher ?? null, v ? aplicado : null, metodo === 'Voucher' ? v.codigo : null], cx)
    const r2 = { id_pago: p.insertId, codigo_pago: codigoPago(p.insertId), monto: t.total, metodo_pago: metodo, tipo_pago: s.tipo_pago, voucher: v ? { codigo: v.codigo, aplicado } : null, resto }
    if (metodo === 'PayPal') {
      const usd = round2(resto / TASA())
      const front = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
      const orden = await crearOrden({
        montoUsd: usd, referencia: s.codigo_seguimiento, descripcion: `${{ Total: 'Pago', Cargo: 'Cargo adicional' }[s.tipo_pago] || `${s.tipo_pago} 50%`} · Solicitud ${s.codigo_seguimiento} · Directorio Servicios`,
        returnUrl: `${front}/pagos/paypal/retorno?pago=${p.insertId}`,
        cancelUrl: `${front}/pagos/${s.codigo_seguimiento}?cancelado=1`,
      })
      await exec(
        "INSERT INTO paypal_transacciones (id_pago, paypal_order_id, monto_usd, tasa_cambio, estado_paypal) VALUES (?, ?, ?, ?, 'CREATED')",
        [p.insertId, orden.id, usd, TASA()], cx)
      Object.assign(r2, { paypal_order_id: orden.id, monto_usd: usd, aprobar_url: orden.aprobarUrl, simulado: paypalSimulado() })
    }
    return r2
  })
  // Cubierto por completo con el voucher: se confirma ya (factura e-CF con forma de pago "nota de crédito")
  if (out.metodo_pago === 'Voucher') {
    await confirmarPago(out.id_pago, { referencia: out.voucher.codigo })
    out.estado = 'Confirmado'
  }
  res.status(201).json(out)
})

async function pagoPropio(req, metodo) {
  const p = await one('SELECT * FROM pagos WHERE id_pago = ?', [req.params.id])
  if (!p) throw notFound('Pago no encontrado')
  if (p.id_cliente !== req.usuario.id_cliente) throw forbidden()
  if (metodo && p.metodo_pago !== metodo) throw badRequest('Método de pago no corresponde')
  if (p.estado !== 'Pendiente') throw conflict(`El pago está ${p.estado}`)
  return p
}

// ---------- PAG-P02 · PayPal: captura de la orden aprobada ----------
rPagos.post('/:id/paypal/capturar', autenticar, soloRol('Cliente', 'Empleado'), async (req, res) => {
  const previo = await one('SELECT id_cliente, estado, referencia FROM pagos WHERE id_pago = ?', [req.params.id])
  if (previo?.estado === 'Confirmado' && previo.id_cliente === req.usuario.id_cliente) return res.json({ estado: 'Confirmado', capture_id: previo.referencia })
  const p = await pagoPropio(req, 'PayPal')
  const tx = await one("SELECT TOP 1 * FROM paypal_transacciones WHERE id_pago = ? ORDER BY id_transaccion DESC", [p.id_pago])
  if (!tx) throw badRequest('No hay orden de PayPal para este pago')
  const cap = await capturarOrden(tx.paypal_order_id)
  if (cap.status === 'COMPLETED') {
    await exec("UPDATE paypal_transacciones SET estado_paypal = 'COMPLETED', paypal_capture_id = ? WHERE id_transaccion = ?", [cap.captureId, tx.id_transaccion])
    await confirmarPago(p.id_pago, { referencia: cap.captureId })
    return res.json({ estado: 'Confirmado', capture_id: cap.captureId })
  }
  await transaction(async (cx) => {
    await exec("UPDATE paypal_transacciones SET estado_paypal = 'DECLINED' WHERE id_transaccion = ?", [tx.id_transaccion], cx)
    await rechazarPago(p.id_pago, 'PayPal declinó el pago.', cx)
  })
  res.status(402).json({ estado: 'Rechazado', error: 'PayPal declinó el pago. Reintenta o elige otro método.' })
})

// ---------- PAG-P03 · Tarjeta (pasarela Azul / CardNet) ----------
// El formulario es alojado por la pasarela; aquí solo llega el resultado. Los datos de la tarjeta nunca pasan por el sistema.
// TODO: reemplazar la simulación con la verificación de la respuesta firmada de Azul / CardNet.
rPagos.post('/:id/tarjeta', autenticar, soloRol('Cliente', 'Empleado'), async (req, res) => {
  const p = await pagoPropio(req, 'Tarjeta')
  const ultimos4 = String(req.body.ultimos4 || '').replace(/\D/g, '').slice(-4)
  const aprobada = ultimos4 !== '0002' // tarjeta de prueba ...0002 = declinada
  if (aprobada) {
    const autorizacion = String(crypto.randomInt(100000, 999999))
    await confirmarPago(p.id_pago, { referencia: `AUT-${autorizacion}` })
    return res.json({ estado: 'Confirmado', autorizacion })
  }
  await transaction((cx) => rechazarPago(p.id_pago, 'Tarjeta declinada: fondos insuficientes.', cx))
  res.status(402).json({ estado: 'Rechazado', error: 'Tarjeta declinada. Reintenta o elige otro método.' })
})

// ---------- PAG-P04 · Transferencia con comprobante ----------
rPagos.post('/:id/transferencia', autenticar, soloRol('Cliente'), upload.single('comprobante'), async (req, res) => {
  const p = await pagoPropio(req, 'Transferencia')
  const ref = String(req.body.referencia || '').trim()
  validar({
    referencia: !/^[A-Za-z0-9-]{4,60}$/.test(ref) && 'Indique el número de transferencia',
    comprobante: !req.file && 'Adjunte el comprobante (JPG, PNG o PDF hasta 5 MB)',
  })
  await transaction(async (cx) => {
    await exec("UPDATE pagos SET estado = 'En verificación', referencia = ?, comprobante_url = ?, fecha_pago = COALESCE(TRY_CAST(? AS datetime2), fecha_pago) WHERE id_pago = ?",
      [ref, urlArchivo(req.file), req.body.fecha || null, p.id_pago], cx)
    await notificarAdmins({ tipo: 'Pago', titulo: `Transferencia ${codigoPago(p.id_pago)} por conciliar`, mensaje: `Referencia ${ref} · RD$ ${Number(p.monto).toFixed(2)}` }, cx)
    const c = await one('SELECT id_usuario FROM clientes WHERE id_cliente = ?', [p.id_cliente], cx)
    await notificar(c.id_usuario, { tipo: 'Pago', titulo: `Tu transferencia ${codigoPago(p.id_pago)} está en verificación`, mensaje: 'Administración la concilia en un máximo de 24 h hábiles.' }, cx)
  })
  res.json({ estado: 'En verificación' })
})

// ---------- Mis pagos y recibo ----------
rPagos.get('/mios', autenticar, soloRol('Cliente', 'Empleado'), async (req, res) => {
  res.json(await query(
    `SELECT p.id_pago, p.monto, p.metodo_pago, p.tipo_pago, p.referencia, p.estado, p.fecha_pago, p.observacion,
            s.codigo_seguimiento AS solicitud, pl.nombre AS [plan], f.numero_factura
       FROM pagos p LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       LEFT JOIN suscripciones su ON su.id_suscripcion = p.id_suscripcion LEFT JOIN planes pl ON pl.id_plan = su.id_plan
       OUTER APPLY (${SQL_DOCUMENTO_PAGO}) f
      WHERE p.id_cliente = ? ORDER BY p.id_pago DESC`,
    [req.usuario.id_cliente],
  ).then((rows) => rows.map((x) => ({ ...x, codigo_pago: codigoPago(x.id_pago) }))))
})

rPagos.get('/:id/recibo', autenticar, async (req, res) => {
  const p = await one(
    `SELECT p.*, s.codigo_seguimiento, t.paypal_capture_id, t.monto_usd, f.numero_factura, e.ncf, e.estado_dgii,
            (SELECT codigo FROM vouchers WHERE id_voucher = p.id_voucher) AS voucher,
            CONCAT(u.nombre, ' ', u.apellido) AS cliente, u.email
       FROM pagos p JOIN clientes c ON c.id_cliente = p.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
       LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       OUTER APPLY (SELECT TOP 1 paypal_capture_id, monto_usd FROM paypal_transacciones WHERE id_pago = p.id_pago ORDER BY id_transaccion DESC) t
       OUTER APPLY (${SQL_DOCUMENTO_PAGO}) f LEFT JOIN ecf e ON e.id_factura = f.id_factura
      WHERE p.id_pago = ?`,
    [req.params.id],
  )
  if (!p) throw notFound('Pago no encontrado')
  if (req.usuario.nombre_rol !== 'Administrador' && p.id_cliente !== req.usuario.id_cliente) throw forbidden()
  res.json({ ...p, codigo_pago: codigoPago(p.id_pago) })
})

// ---------- PAG-P08 · Estado de cuenta del prestador (modelo marketplace) ----------
const SQL_MOVIMIENTOS = `SELECT TOP 300 m.id_movimiento, m.fecha, m.tipo, m.descripcion, m.monto, s.codigo_seguimiento AS solicitud, m.id_pago
   FROM movimientos_prestador m LEFT JOIN solicitudes_servicio s ON s.id_solicitud = m.id_solicitud
  WHERE m.id_empleado = ? ORDER BY m.fecha DESC, m.id_movimiento DESC`

/** Resumen de la cuenta: saldo, totales del mes y condiciones vigentes (comisión y membresía). */
async function cuentaPrestador(id_empleado) {
  const mes = await one(
    `SELECT COALESCE(SUM(IIF(tipo = 'Servicio realizado', monto, 0)), 0) AS ganado,
            COALESCE(SUM(IIF(tipo IN ('Comisión', 'Comisión extra'), -monto, 0)), 0) AS comisiones,
            COALESCE(SUM(IIF(tipo = 'Efectivo cobrado', -monto, 0)), 0) AS efectivo
       FROM movimientos_prestador WHERE id_empleado = ? AND fecha >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)`, [id_empleado])
  const a = await ajustesCobro()
  const plan = await planPrestador(id_empleado)
  return {
    saldo: await saldoPrestador(id_empleado),
    mes: { ganado: round2(mes.ganado), comisiones: round2(mes.comisiones), efectivo: round2(mes.efectivo) },
    condiciones: { comision_pct: await comisionPctDe(id_empleado), comision_min: a.comision_min, comision_general_pct: a.comision_pct },
    membresia: plan ? { plan: plan.nombre, estado: plan.estado, vence: plan.fecha_renovacion, prioridad: !!plan.prioridad_asignacion, destacado: !!plan.destacado } : null,
    movimientos: await query(SQL_MOVIMIENTOS, [id_empleado]),
  }
}

rPagos.get('/prestador/cuenta', autenticar, soloRol('Empleado'), async (req, res) => {
  res.json(await cuentaPrestador(req.usuario.id_empleado))
})

// ---------- PAG-P05 · Cobro en efectivo reportado por el prestador ----------
rPagos.post('/efectivo', autenticar, soloRol('Empleado'), upload.single('foto'), async (req, res) => {
  const monto = Number(String(req.body.monto || '').replace(/,/g, ''))
  const recibo = String(req.body.recibo || '').trim()
  validar({ recibo: !/^[A-Za-z0-9-]{3,60}$/.test(recibo) && 'Indique el número de recibo' })
  const out = await transaction(async (cx) => {
    const s = await one(
      `SELECT s.* FROM solicitudes_servicio s JOIN asignaciones_servicio a ON a.id_solicitud = s.id_solicitud
        WHERE s.codigo_seguimiento = ? AND a.id_empleado = ? AND a.estado_asignacion IN ('Aceptada','Completada')`,
      [req.body.codigo, req.usuario.id_empleado], cx)
    if (!s) throw notFound('Solicitud no encontrada entre tus servicios aceptados')
    const { tipo_pago, id_cargo } = await solicitudPagable(s.codigo_seguimiento, null, cx)
    const t = await lineasCobro(s.id_solicitud, tipo_pago, cx, id_cargo)
    const concepto = { Total: 'el total', Anticipo: 'el anticipo (50 %)', Saldo: 'el saldo (50 %)', Cargo: 'el cargo adicional' }[tipo_pago]
    if (round2(monto) !== round2(t.total)) throw badRequest(`El monto no coincide con ${concepto}: RD$ ${t.total.toFixed(2)}`)
    await exec("UPDATE pagos SET estado = 'Rechazado', observacion = 'Reemplazado por cobro en efectivo' WHERE id_solicitud = ? AND estado = 'Pendiente'", [s.id_solicitud], cx)
    const p = await exec(
      "INSERT INTO pagos (id_cliente, id_solicitud, monto, metodo_pago, tipo_pago, id_cargo, referencia, comprobante_url, estado) VALUES (?, ?, ?, 'Efectivo', ?, ?, ?, ?, 'En verificación')",
      [s.id_cliente, s.id_solicitud, t.total, tipo_pago, id_cargo, recibo, urlArchivo(req.file)], cx)
    await notificarAdmins({ tipo: 'Pago', titulo: `Cobro en efectivo ${codigoPago(p.insertId)} por conciliar`, mensaje: `${s.codigo_seguimiento} · ${tipo_pago} · recibo ${recibo} · RD$ ${t.total.toFixed(2)}` }, cx)
    return { id_pago: p.insertId, codigo_pago: codigoPago(p.insertId), tipo_pago, estado: 'En verificación' }
  })
  res.status(201).json(out)
})

rPagos.get('/efectivo/mios', autenticar, soloRol('Empleado'), async (req, res) => {
  res.json(await query(
    `SELECT p.id_pago, p.tipo_pago, s.codigo_seguimiento AS solicitud, CONCAT(u.nombre, ' ', u.apellido) AS cliente, p.referencia AS recibo,
            p.fecha_pago, p.monto, p.estado
       FROM pagos p JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       JOIN asignaciones_servicio a ON a.id_solicitud = s.id_solicitud AND a.estado_asignacion IN ('Aceptada','Completada')
       JOIN clientes c ON c.id_cliente = p.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
      WHERE p.metodo_pago = 'Efectivo' AND a.id_empleado = ? ORDER BY p.id_pago DESC`,
    [req.usuario.id_empleado]))
})

// =====================================================================
// PAG-P06 · Conciliación (administrador)
// =====================================================================
export const conciliacion = Router()
conciliacion.use(autenticar, soloRol('Administrador'))

conciliacion.get('/', async (req, res) => {
  const estado = req.query.estado || 'En verificación'
  const filas = await query(
    `SELECT TOP 300 p.id_pago, p.monto, p.metodo_pago, p.tipo_pago, p.referencia, p.comprobante_url, p.estado, p.fecha_pago, p.observacion, p.monto_voucher,
            (SELECT codigo FROM vouchers WHERE id_voucher = p.id_voucher) AS voucher,
            s.codigo_seguimiento AS solicitud, CONCAT(u.nombre, ' ', u.apellido) AS cliente, c.razon_social,
            CONCAT(ua.nombre, ' ', ua.apellido) AS confirmado_por
       FROM pagos p JOIN clientes c ON c.id_cliente = p.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
       LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
       LEFT JOIN usuarios ua ON ua.id_usuario = p.confirmado_por
      ${estado === 'Todos' ? '' : 'WHERE p.estado = ?'} ORDER BY p.fecha_pago DESC`,
    estado === 'Todos' ? [] : [estado])
  const kpis = await one(
    `SELECT (SELECT COUNT(*) FROM pagos WHERE estado = 'En verificación') AS en_verificacion,
            (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE estado = 'En verificación') AS monto_verificacion,
            (SELECT COUNT(*) FROM pagos WHERE estado = 'Confirmado' AND CAST(fecha_pago AS date) = CAST(GETDATE() AS date)) AS confirmados_hoy,
            (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE estado = 'Confirmado' AND CAST(fecha_pago AS date) = CAST(GETDATE() AS date)) AS monto_hoy,
            (SELECT COUNT(*) FROM pagos WHERE estado = 'Rechazado' AND YEAR(fecha_pago) = YEAR(GETDATE()) AND MONTH(fecha_pago) = MONTH(GETDATE())) AS rechazados_mes,
            (SELECT CAST(100.0 * SUM(CASE WHEN metodo_pago IN ('PayPal','Tarjeta') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS DECIMAL(5,1))
               FROM pagos WHERE estado = 'Confirmado' AND YEAR(fecha_pago) = YEAR(GETDATE()) AND MONTH(fecha_pago) = MONTH(GETDATE())) AS pct_en_linea`)
  res.json({ kpis, pagos: filas.map((x) => ({ ...x, codigo_pago: codigoPago(x.id_pago) })) })
})

conciliacion.post('/:id/conciliar', async (req, res) => {
  const p = await one('SELECT * FROM pagos WHERE id_pago = ?', [req.params.id])
  if (!p) throw notFound('Pago no encontrado')
  if (p.estado !== 'En verificación') throw conflict('Solo se concilian pagos En verificación')
  const decision = req.body.decision
  const obs = String(req.body.observacion || '').trim()
  if (decision === 'Confirmar') {
    await confirmarPago(p.id_pago, { confirmado_por: req.usuario.id_usuario })
    await auditar(req, 'Pago conciliado (Confirmado)', 'pagos', p.id_pago, { estado: p.estado }, { estado: 'Confirmado' })
    return res.json({ estado: 'Confirmado' })
  }
  if (decision !== 'Rechazar') throw badRequest('Decisión inválida')
  if (!obs) throw badRequest('Indique el motivo del rechazo')
  await transaction(async (cx) => {
    await rechazarPago(p.id_pago, obs, cx)
    await auditar(req, 'Pago conciliado (Rechazado)', 'pagos', p.id_pago, { estado: p.estado }, { estado: 'Rechazado', observacion: obs }, cx)
  })
  res.json({ estado: 'Rechazado' })
})

// Reembolso: un pago confirmado solo se revierte así (aprobado por el administrador).
// Ante la DGII se respalda con una nota de crédito e34 que anula su factura (un e-CF no se "cancela").
conciliacion.post('/:id/reembolsar', async (req, res) => {
  const motivo = String(req.body.motivo || '').trim()
  if (!motivo) throw badRequest('Indique el motivo del reembolso')
  const comoVoucher = req.body.forma === 'Voucher'
  let voucher = null
  const notas = await transaction(async (cx) => {
    const p = await one('SELECT * FROM pagos WITH (UPDLOCK, ROWLOCK) WHERE id_pago = ?', [req.params.id], cx)
    if (!p) throw notFound('Pago no encontrado')
    if (p.estado !== 'Confirmado') throw conflict('Solo se reembolsan pagos confirmados')
    await exec("UPDATE pagos SET estado = 'Reembolsado', observacion = ? WHERE id_pago = ?", [motivo.slice(0, 200), p.id_pago], cx)
    const nc = await notasCreditoDePago(cx, p.id_pago, motivo)
    await reversarPago(cx, p.id_pago)
    // Lo pagado con voucher vuelve solo a ese voucher; el resto se devuelve en dinero o como un voucher nuevo
    const enDinero = round2(Number(p.monto) - Number(p.monto_voucher || 0))
    if (comoVoucher && enDinero > 0) {
      voucher = await crearVoucher(cx, { id_cliente: p.id_cliente, monto: enDinero, origen: 'Reembolso', id_pago_origen: p.id_pago, id_nota: nc[0]?.id_factura ?? null, creado_por: req.usuario.id_usuario })
      const c = await one('SELECT id_usuario FROM clientes WHERE id_cliente = ?', [p.id_cliente], cx)
      await notificar(c.id_usuario, {
        tipo: 'Pago', titulo: `Tienes un voucher de RD$ ${enDinero.toFixed(2)}`,
        mensaje: `Por el reembolso del pago ${codigoPago(p.id_pago)} te emitimos el voucher ${voucher.codigo}. Úsalo como forma de pago en tu próximo servicio.`, canales: ['App', 'Correo'],
      }, cx)
    }
    if (p.id_cargo) await exec("UPDATE cargos_adicionales SET estado = 'Anulado' WHERE id_cargo = ?", [p.id_cargo], cx)
    await auditar(req, 'Pago reembolsado', 'pagos', p.id_pago, { estado: 'Confirmado' }, { estado: 'Reembolsado', motivo, nota_credito: nc.map((n) => n.numero).join(', ') || null }, cx)
    return nc
  })
  for (const n of notas) await emitirDocumento(n.id_factura)
  res.json({ estado: 'Reembolsado', nota_credito: notas.map((n) => n.numero).join(', ') || null, voucher })
})

// ---------- PAG-P08 · Cuentas de prestadores y liquidaciones ----------
conciliacion.get('/prestadores', async (_req, res) => {
  res.json(await query(
    `SELECT e.id_empleado, CONCAT(u.nombre, ' ', u.apellido) AS prestador, e.especialidad,
            COALESCE(SUM(m.monto), 0) AS saldo,
            COALESCE(SUM(IIF(m.tipo IN ('Comisión', 'Comisión extra') AND m.fecha >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1), -m.monto, 0)), 0) AS comisiones_mes,
            MAX(IIF(m.tipo = 'Liquidación', m.fecha, NULL)) AS ultima_liquidacion
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario LEFT JOIN movimientos_prestador m ON m.id_empleado = e.id_empleado
      WHERE e.estado_aprobacion = 'Aprobado'
      GROUP BY e.id_empleado, u.nombre, u.apellido, e.especialidad
      ORDER BY ABS(COALESCE(SUM(m.monto), 0)) DESC, u.nombre`))
})

conciliacion.get('/prestadores/:id', async (req, res) => {
  const e = await one("SELECT e.id_empleado, CONCAT(u.nombre, ' ', u.apellido) AS prestador FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario WHERE e.id_empleado = ?", [req.params.id])
  if (!e) throw notFound('Prestador no encontrado')
  res.json({ ...e, ...(await cuentaPrestador(e.id_empleado)) })
})

/** Liquidación: pago al prestador de su saldo a favor, o cobro de lo que debe (comisiones del efectivo). */
conciliacion.post('/prestadores/:id/liquidar', async (req, res) => {
  const b = req.body
  const monto = round2(Number(String(b.monto || '').replace(/,/g, '')))
  validar({
    sentido: !['Pago al prestador', 'Cobro al prestador'].includes(b.sentido) && 'Indique si es un pago o un cobro',
    monto: !(monto > 0) && 'Indique el monto',
    metodo: !['Transferencia', 'Efectivo', 'PayPal'].includes(b.metodo) && 'Seleccione el método',
  })
  const out = await transaction(async (cx) => {
    const e = await one('SELECT id_empleado, id_usuario FROM empleados WITH (UPDLOCK, ROWLOCK) WHERE id_empleado = ?', [req.params.id], cx)
    if (!e) throw notFound('Prestador no encontrado')
    const saldo = await saldoPrestador(e.id_empleado, cx)
    if (b.sentido === 'Pago al prestador' && monto > saldo) throw conflict(`El saldo a favor del prestador es RD$ ${Math.max(saldo, 0).toFixed(2)}`)
    if (b.sentido === 'Cobro al prestador' && monto > -saldo) throw conflict(`El prestador debe RD$ ${Math.max(-saldo, 0).toFixed(2)}`)
    const referencia = String(b.referencia || '').trim().slice(0, 60) || null
    const l = await exec(
      `INSERT INTO liquidaciones_prestador (id_empleado, sentido, monto, metodo, referencia, observacion, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.id_empleado, b.sentido, monto, b.metodo, referencia, String(b.observacion || '').trim().slice(0, 200) || null, req.usuario.id_usuario], cx)
    await movimientoLiquidacion(cx, { id_empleado: e.id_empleado, id_liquidacion: l.insertId, sentido: b.sentido, monto, metodo: b.metodo, referencia })
    await notificar(e.id_usuario, {
      tipo: 'Pago', titulo: b.sentido === 'Pago al prestador' ? `Te pagamos RD$ ${monto.toFixed(2)}` : `Registramos tu pago de RD$ ${monto.toFixed(2)}`,
      mensaje: `${b.sentido} por ${b.metodo.toLowerCase()}${referencia ? ` (ref. ${referencia})` : ''}. Consulta el detalle en Mis ganancias.`, canales: ['App', 'Correo'],
    }, cx)
    await auditar(req, `Liquidación: ${b.sentido}`, 'liquidaciones_prestador', l.insertId, { saldo }, { monto, metodo: b.metodo, referencia }, cx)
    return { id_liquidacion: l.insertId, saldo: await saldoPrestador(e.id_empleado, cx) }
  })
  res.status(201).json(out)
})

// ---------- Parámetros de cobro: comisión al prestador y tarifa al cliente ----------
conciliacion.get('/ajustes-cobro', async (_req, res) => res.json(await ajustesCobro()))

conciliacion.put('/ajustes-cobro', async (req, res) => {
  const v = {}
  for (const k of ['comision_pct', 'comision_min', 'tarifa_cliente_pct', 'tarifa_cliente_min']) {
    if (req.body[k] === undefined || req.body[k] === '') continue
    v[k] = Number(String(req.body[k]).replace(/,/g, ''))
  }
  validar({
    comision_pct: v.comision_pct !== undefined && !(v.comision_pct >= 0 && v.comision_pct <= 50) && 'Entre 0 y 50 %',
    tarifa_cliente_pct: v.tarifa_cliente_pct !== undefined && !(v.tarifa_cliente_pct >= 0 && v.tarifa_cliente_pct <= 50) && 'Entre 0 y 50 %',
    comision_min: v.comision_min !== undefined && !(v.comision_min >= 0) && 'Monto inválido',
    tarifa_cliente_min: v.tarifa_cliente_min !== undefined && !(v.tarifa_cliente_min >= 0) && 'Monto inválido',
  })
  const antes = await ajustesCobro()
  await guardarAjustesCobro(v)
  await auditar(req, 'Parámetros de cobro actualizados', 'ajustes_plataforma', null, antes, v)
  res.json(await ajustesCobro())
})

// =====================================================================
// PAG-P07 · Webhook de PayPal (firma verificada, eventos duplicados ignorados)
// =====================================================================
export const webhookPaypal = Router()
webhookPaypal.post('/', async (req, res) => {
  const ev = req.body
  if (!ev?.id || !(await verificarWebhook(req.headers, ev).catch(() => false))) return res.status(400).json({ error: 'Firma inválida' })
  if (await one('SELECT 1 AS x FROM paypal_webhooks WHERE evento_id = ?', [ev.id])) return res.sendStatus(200)
  const orderId = ev.resource?.supplementary_data?.related_ids?.order_id || ev.resource?.id
  const tx = orderId ? await one('SELECT * FROM paypal_transacciones WHERE paypal_order_id = ?', [orderId]) : null
  const w = await exec(
    'INSERT INTO paypal_webhooks (id_transaccion, evento_id, evento_tipo, payload_json) VALUES (?, ?, ?, ?)',
    [tx?.id_transaccion || null, ev.id, String(ev.event_type || '').slice(0, 60), JSON.stringify(ev)])
  if (tx && ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    await exec("UPDATE paypal_transacciones SET estado_paypal = 'COMPLETED', paypal_capture_id = COALESCE(paypal_capture_id, ?) WHERE id_transaccion = ?", [ev.resource?.id || null, tx.id_transaccion])
    await confirmarPago(tx.id_pago, { referencia: ev.resource?.id || null }) // no hace nada si ya estaba Confirmado
  }
  await exec('UPDATE paypal_webhooks SET procesado = 1 WHERE id_webhook = ?', [w.insertId])
  res.sendStatus(200)
})

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.use('/pagos', rPagos)
router.use('/admin/pagos', conciliacion)
router.use('/webhooks/paypal', webhookPaypal)
