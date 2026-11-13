import { one, query, HOY } from '../config/db.js'
import { calcularTotales, round2, ITBIS } from './fiscal.js'
import { ajustesCobro, tarifaCliente } from './comisiones.js'

const MESES = { Mensual: 1, Trimestral: 3, Anual: 12 }

/** Plan vigente del cliente. Una suscripción cancelada sigue aplicando hasta el fin del periodo pagado. */
export async function planActivo(id_cliente, cx) {
  return one(
    `SELECT TOP 1 s.id_suscripcion, s.fecha_renovacion, p.id_plan, p.nombre, p.periodicidad
       FROM suscripciones s JOIN planes p ON p.id_plan = s.id_plan
      WHERE s.id_cliente = ? AND p.dirigido_a = 'Cliente' AND s.estado IN ('Activa', 'Cancelada') AND s.fecha_renovacion >= ${HOY}
      ORDER BY s.fecha_inicio DESC`,
    [id_cliente],
    cx,
  )
}

/**
 * Aplica el plan a las líneas (plan_servicio):
 *  - cantidad_incluida: usos sin costo por periodo; se descuentan los ya usados en solicitudes anteriores del periodo.
 *  - descuento_pct: descuento sobre lo que exceda la cantidad incluida.
 * Una línea con usos incluidos se divide en dos (incluida al 100 % + resto), para que cada
 * línea de factura cumpla total_linea = cantidad × precio_unitario + itbis_linea.
 * `antesDe` limita el conteo a solicitudes anteriores, así checkout y factura dan el mismo total.
 */
export async function aplicarPlan(id_cliente, lineas, antesDe, cx) {
  const plan = await planActivo(id_cliente, cx)
  if (!plan) return { plan: null, lineas: lineas.map((l) => ({ ...l, descuento_pct: 0 })) }

  const reglas = {}
  for (const ps of await query('SELECT id_servicio, cantidad_incluida, descuento_pct FROM plan_servicio WHERE id_plan = ?', [plan.id_plan], cx)) {
    reglas[ps.id_servicio] = { incluida: Number(ps.cantidad_incluida), pct: Number(ps.descuento_pct) }
  }
  const usados = {}
  const filas = await query(
    `SELECT d.id_servicio, SUM(d.cantidad) AS usados
       FROM solicitud_detalle d JOIN solicitudes_servicio s ON s.id_solicitud = d.id_solicitud
      WHERE s.id_cliente = ? AND s.estado <> 'Cancelado' AND s.id_solicitud < ? AND d.id_servicio IS NOT NULL
        AND s.fecha_solicitud >= DATEADD(MONTH, -?, ?)
      GROUP BY d.id_servicio`,
    [id_cliente, antesDe, MESES[plan.periodicidad] || 1, plan.fecha_renovacion],
    cx,
  )
  for (const f of filas) usados[f.id_servicio] = Number(f.usados)

  const out = []
  for (const l of lineas) {
    const regla = l.id_servicio ? reglas[l.id_servicio] : null
    if (!regla) { out.push({ ...l, descuento_pct: 0 }); continue }
    const disponibles = Math.max(regla.incluida - (usados[l.id_servicio] || 0), 0)
    const incluidas = Math.min(disponibles, l.cantidad)
    usados[l.id_servicio] = (usados[l.id_servicio] || 0) + incluidas
    if (incluidas > 0) {
      out.push({ ...l, nombre: `${l.nombre} (incluido en plan ${plan.nombre})`, cantidad: incluidas, subtotal: incluidas * l.precio_unitario, descuento_pct: 100 })
    }
    const resto = l.cantidad - incluidas
    if (resto > 0) out.push({ ...l, cantidad: resto, subtotal: resto * l.precio_unitario, descuento_pct: regla.pct })
  }
  return { plan: plan.nombre, lineas: out }
}

/**
 * v_totalPagar: subtotal − descuento de plan + ITBIS 18 % de las líneas gravadas.
 * Se recalcula siempre en el servidor (PAG-P01: no se acepta el monto del navegador).
 */
// Línea de servicio (incluye la tarifa de la plataforma sobre los servicios); el resto son materiales
const esServicio = (d) => (d.id_servicio !== null && d.id_servicio !== undefined) || d.tarifa === 'servicio'

export async function totalesSolicitud(id_solicitud, cx) {
  const sol = await one('SELECT id_solicitud, id_cliente, tarifa_pct, tarifa_min FROM solicitudes_servicio WHERE id_solicitud = ?', [id_solicitud], cx)
  if (!sol) return null
  const lineas = await query(
    `SELECT d.id_detalle, d.id_servicio, d.cantidad, d.precio_unitario, d.subtotal, d.aplica_itbis, COALESCE(d.descripcion, s.nombre) AS nombre
       FROM solicitud_detalle d LEFT JOIN servicios s ON s.id_servicio = d.id_servicio
      WHERE d.id_solicitud = ? ORDER BY d.id_detalle`,
    [id_solicitud],
    cx,
  )
  const base = lineas.map((l) => ({
    ...l, cantidad: Number(l.cantidad), precio_unitario: Number(l.precio_unitario), subtotal: Number(l.subtotal), aplica_itbis: !!l.aplica_itbis,
  }))
  const { plan, lineas: conPlan } = await aplicarPlan(sol.id_cliente, base, sol.id_solicitud, cx)
  return { ...calcularTotales(conTarifa(conPlan, sol.tarifa_pct, sol.tarifa_min)), plan }
}

/**
 * Tarifa de servicio de la plataforma al cliente (como Freelancer): % del neto con un mínimo sobre los servicios,
 * y el mismo % sin mínimo sobre los materiales. Las solicitudes anteriores (tarifa_pct NULL) no la llevan.
 * La de servicios se cobra como un servicio (50 % con el anticipo); la de materiales, con los materiales.
 */
function conTarifa(lineas, pct, minimo) {
  if (pct == null) return lineas
  const netos = calcularTotales(lineas).detalle
  const neto = (servicio) => round2(netos.filter((d) => esServicio(d) === servicio).reduce((s, d) => s + d.total_linea - d.itbis_linea, 0))
  const linea = (tarifa, monto, nombre) => ({ id_servicio: null, tarifa, nombre, cantidad: 1, precio_unitario: monto, subtotal: monto, aplica_itbis: true, descuento_pct: 0 })
  const ts = tarifaCliente(neto(true), Number(pct), Number(minimo || 0))
  const tm = tarifaCliente(neto(false), Number(pct))
  return [
    ...lineas,
    ...(ts > 0 ? [linea('servicio', ts, `Tarifa de servicio de la plataforma (${Number(pct)} %)`)] : []),
    ...(tm > 0 ? [linea('materiales', tm, `Tarifa de servicio sobre materiales (${Number(pct)} %)`)] : []),
  ]
}

/** Total estimado antes de registrar la solicitud (paso 4 de SOL-P01). */
export async function cotizar(id_cliente, servicios, cx) {
  const base = servicios.map((s) => ({
    id_servicio: s.id_servicio, nombre: s.nombre, cantidad: s.cantidad, precio_unitario: Number(s.precio_base),
    subtotal: Number(s.precio_base) * s.cantidad, aplica_itbis: !!s.aplica_itbis,
  }))
  const { plan, lineas } = await aplicarPlan(id_cliente, base, 2147483647, cx)
  const a = await ajustesCobro(cx)
  return { ...calcularTotales(conTarifa(lineas, a.tarifa_cliente_pct, a.tarifa_cliente_min)), plan }
}

// =====================================================================
// Pago fraccionado: 50 % de anticipo al aceptar el prestador + 50 % de saldo al finalizar
// =====================================================================
export const PCT_ANTICIPO = 0.5

/**
 * Documento de un pago, para OUTER APPLY sobre p: su factura (o nota de débito), y para el saldo que se abona
 * a la factura del servicio, esa factura. Se prefiere el vigente sobre el anulado y la factura sobre la nota.
 */
export const SQL_DOCUMENTO_PAGO =
  `SELECT TOP 1 x.id_factura, x.numero_factura FROM facturas x
    WHERE x.tipo_documento <> 'Nota de crédito' AND (x.id_pago = p.id_pago OR (p.tipo_pago = 'Saldo' AND x.tipo_documento = 'Factura'
          AND x.id_pago IN (SELECT a.id_pago FROM pagos a WHERE a.id_solicitud = p.id_solicitud AND a.tipo_pago = 'Anticipo')))
    ORDER BY IIF(x.estado = 'Emitida', 0, 1), IIF(x.tipo_documento = 'Factura', 0, 1), IIF(x.id_pago = p.id_pago, 0, 1), x.id_factura DESC`

/**
 * Factura del servicio pagado en abonos: se emite al confirmar el anticipo por el 100 % de los servicios,
 * y el saldo se abona a ella. Las facturas de anticipo anteriores a este esquema (por el 50 %, igual al
 * monto del anticipo) no cuentan: esas solicitudes terminan con su propia factura de saldo.
 */
export async function facturaDelServicio(id_solicitud, cx) {
  return one(
    `SELECT TOP 1 f.id_factura, f.numero_factura, f.total, f.tipo_ecf, f.rnc_comprador, f.razon_social_comprador, p.id_pago AS id_pago_anticipo, p.monto AS anticipo
       FROM facturas f JOIN pagos p ON p.id_pago = f.id_pago
      WHERE p.id_solicitud = ? AND p.tipo_pago = 'Anticipo' AND p.estado IN ('Confirmado', 'Reembolsado')
        AND f.tipo_documento = 'Factura' AND f.estado = 'Emitida' AND f.total <> p.monto
      ORDER BY f.id_factura DESC`, [id_solicitud], cx)
}


/**
 * Parte de una línea (neto e ITBIS) que corresponde al anticipo y al saldo. El ITBIS del saldo es el de la
 * línea menos el del anticipo, para que anticipo + saldo sumen exactamente el total de la línea.
 */
function partirLinea(neto, itbisLinea, nombre, id_servicio) {
  const baseA = round2(neto * PCT_ANTICIPO)
  const itbisA = itbisLinea > 0 ? round2(baseA * ITBIS) : 0
  const parte = (prefijo, base, itbis) => ({
    id_servicio, nombre: `${prefijo} 50% · ${nombre}`, cantidad: 1, precio_unitario: base, precio_neto: base, subtotal: base,
    aplica_itbis: itbisLinea > 0, descuento_linea: 0, itbis_linea: itbis, total_linea: round2(base + itbis),
  })
  return { anticipo: parte('Anticipo', baseA, itbisA), saldo: parte('Saldo', round2(neto - baseA), round2(itbisLinea - itbisA)) }
}

const conTotales = (detalle, plan) => {
  const subtotal = round2(detalle.reduce((s, l) => s + l.subtotal, 0))
  const descuento = round2(detalle.reduce((s, l) => s + (l.descuento_linea || 0), 0))
  const itbis = round2(detalle.reduce((s, l) => s + l.itbis_linea, 0))
  return { detalle, subtotal, descuento, itbis, total: round2(subtotal - descuento + itbis), plan }
}

/**
 * Líneas y totales de un cobro según su tipo (mismo formato que totalesSolicitud):
 *  - Total:      todas las líneas (pago único).
 *  - Anticipo:   50 % de cada línea de servicio (los materiales aún no existen).
 *  - Saldo:      el resto de cada línea de servicio + los materiales agregados al cerrar. Si ya hay factura
 *                del servicio, el resto se toma de sus líneas, para que anticipo + saldo cuadren con ella.
 *  - Servicios:  las líneas de servicio al 100 % (factura del servicio, emitida con el anticipo).
 *  - Materiales: los materiales agregados al cerrar (nota de débito sobre la factura del servicio).
 * Cada línea parcial es cantidad 1 × base neta + ITBIS 18 %, para que la factura cuadre con el pago.
 */
export async function lineasCobro(id_solicitud, tipo, cx, id_cargo = null) {
  if (tipo === 'Cargo') return lineasCargo(id_solicitud, id_cargo, cx)
  const t = await totalesSolicitud(id_solicitud, cx)
  if (!t || tipo === 'Total') return t
  if (tipo === 'Servicios' || tipo === 'Materiales') return conTotales(t.detalle.filter((d) => esServicio(d) === (tipo === 'Servicios')), t.plan)
  const materiales = t.detalle.filter((d) => !esServicio(d)).map((d) => ({ ...d, precio_unitario: d.precio_neto, subtotal: round2(d.total_linea - d.itbis_linea), descuento_linea: 0 }))
  const factura = tipo === 'Saldo' ? await facturaDelServicio(id_solicitud, cx) : null
  const servicios = factura
    ? (await query('SELECT * FROM factura_detalle WHERE id_factura = ? ORDER BY id_factura_detalle', [factura.id_factura], cx))
      .map((l) => ({ neto: round2(Number(l.total_linea) - Number(l.itbis_linea)), itbis: Number(l.itbis_linea), nombre: l.descripcion, id_servicio: l.id_servicio }))
    : t.detalle.filter(esServicio).map((d) => ({ neto: round2(d.total_linea - d.itbis_linea), itbis: d.itbis_linea, nombre: d.nombre, id_servicio: d.id_servicio }))
  const partes = servicios.map((l) => partirLinea(l.neto, l.itbis, l.nombre, l.id_servicio)[tipo === 'Anticipo' ? 'anticipo' : 'saldo'])
  const detalle = [...partes, ...(tipo === 'Saldo' ? materiales : [])].filter((l) => l.precio_unitario > 0)
  return conTotales(detalle, t.plan)
}

/**
 * Cargo adicional aceptado por el cliente (se factura con nota de débito e33).
 * Sin id_cargo toma el cargo aceptado más antiguo que aún no tiene pago.
 */
async function lineasCargo(id_solicitud, id_cargo, cx) {
  const c = await one(
    `SELECT TOP 1 * FROM cargos_adicionales WHERE id_solicitud = ? AND ${id_cargo ? 'id_cargo = ?' : "estado = 'Aceptado'"} ORDER BY id_cargo`,
    id_cargo ? [id_solicitud, id_cargo] : [id_solicitud], cx)
  if (!c) return null
  const precio = Number(c.precio_unitario), cant = Number(c.cantidad)
  const sol = await one('SELECT tarifa_pct FROM solicitudes_servicio WHERE id_solicitud = ?', [id_solicitud], cx)
  const tarifa = tarifaCliente(round2(precio * cant), Number(sol?.tarifa_pct ?? 0))
  const t = calcularTotales([
    { id_servicio: null, nombre: `Cargo adicional: ${c.descripcion}`, cantidad: cant, precio_unitario: precio, subtotal: precio * cant, aplica_itbis: !!c.aplica_itbis },
    ...(tarifa > 0 ? [{ id_servicio: null, nombre: `Tarifa de servicio sobre cargo adicional (${Number(sol.tarifa_pct)} %)`, cantidad: 1, precio_unitario: tarifa, subtotal: tarifa, aplica_itbis: true }] : []),
  ])
  return { ...t, plan: null, id_cargo: c.id_cargo, cargo: c }
}

/**
 * Estado del cobro de una solicitud y el siguiente pago que corresponde.
 * Un pago "cuenta" si está Confirmado o En verificación (los Pendientes son intentos sin terminar).
 */
export async function estadoCobro(id_solicitud, cx) {
  const sol = await one('SELECT estado FROM solicitudes_servicio WHERE id_solicitud = ?', [id_solicitud], cx)
  const pagos = await query(
    `SELECT p.id_pago, p.tipo_pago, p.id_cargo, p.estado, p.monto, p.metodo_pago, f.numero_factura
       FROM pagos p OUTER APPLY (${SQL_DOCUMENTO_PAGO}) f
      WHERE p.id_solicitud = ? AND p.estado IN ('En verificación', 'Confirmado') ORDER BY p.id_pago`,
    [id_solicitud], cx)
  const de = (tipo) => pagos.find((p) => p.tipo_pago === tipo) || null
  const total = await totalesSolicitud(id_solicitud, cx)
  const cargos = await query(
    `SELECT id_cargo, descripcion, motivo, cantidad, precio_unitario, aplica_itbis, estado, fecha_solicitud, fecha_respuesta, motivo_rechazo
       FROM cargos_adicionales WHERE id_solicitud = ? ORDER BY id_cargo`, [id_solicitud], cx)
  for (const c of cargos) {
    c.total = (await lineasCargo(id_solicitud, c.id_cargo, cx)).total // con ITBIS y tarifa de la plataforma
    c.pago = pagos.find((p) => p.id_cargo === c.id_cargo) || null
  }
  // Cargo aceptado sin pago confirmado ni en verificación: es lo siguiente que se cobra
  const cargoPorPagar = cargos.find((c) => c.estado === 'Aceptado' && !c.pago)
  const r = {
    total_servicio: total.total, cubierto_por_plan: total.total === 0, total: de('Total'), anticipo: de('Anticipo'), saldo: de('Saldo'),
    pagos, cargos, siguiente: null, motivo: null,
  }

  if (cargoPorPagar) {
    r.siguiente = 'Cargo'
    r.id_cargo = cargoPorPagar.id_cargo
  } else if (r.cubierto_por_plan) r.motivo = 'Este servicio está cubierto por tu plan y no requiere pago'
  else if (r.total || r.saldo) r.motivo = 'Esta solicitud ya está pagada'
  else if (sol.estado === 'Pendiente') r.motivo = 'El anticipo del 50 % se paga cuando el prestador acepte la solicitud'
  else if (sol.estado === 'Cancelado') r.motivo = 'La solicitud está cancelada'
  else if (sol.estado === 'En proceso') {
    if (!r.anticipo) r.siguiente = 'Anticipo'
    else r.motivo = r.anticipo.estado === 'En verificación'
      ? 'El anticipo está en verificación. El saldo se paga al finalizar el servicio'
      : 'Anticipo pagado. El saldo del 50 % se paga cuando confirmes la finalización del servicio'
  } else if (sol.estado === 'Completado') r.siguiente = r.anticipo ? 'Saldo' : 'Total'

  if (r.siguiente) r.monto_siguiente = (await lineasCobro(id_solicitud, r.siguiente, cx, r.id_cargo)).total
  r.pagado = !!(r.total?.estado === 'Confirmado' || r.saldo?.estado === 'Confirmado' || r.cubierto_por_plan)
  r.anticipo_listo = !!(r.anticipo || r.total || r.cubierto_por_plan)
  return r
}

/** Texto corto del estado del cobro para listas (Mis solicitudes, panel del prestador). */
export function textoCobro(c) {
  if (c.cubierto_por_plan) return 'Cubierto por plan'
  const ultimo = c.total || c.saldo
  if (ultimo) return ultimo.estado === 'Confirmado' ? 'Pagado' : `${c.saldo ? 'Saldo' : 'Pago'} en verificación`
  if (c.anticipo) return c.anticipo.estado === 'Confirmado' ? 'Anticipo pagado' : 'Anticipo en verificación'
  return null
}
