// Modelo de cobro tipo marketplace (como Freelancer):
//  - Tarifa al cliente: % de lo cobrado sin ITBIS, con un mínimo por servicio (línea propia en la factura).
//  - Comisión al prestador: % del valor del servicio sin ITBIS, con un mínimo, cargada al aceptar la asignación.
//    Los materiales y los cargos adicionales pagan el mismo % (sin mínimo) al cobrarse.
//  - Membresía opcional del prestador (planes dirigidos a Prestador): comisión reducida, prioridad y destacado.
//  - Estado de cuenta del prestador: monto > 0 a su favor (lo que la plataforma le debe), < 0 en su contra.
import { exec, one, query, HOY } from '../config/db.js'
import { round2 } from './fiscal.js'

const PARAMETROS = ['comision_pct', 'comision_min', 'tarifa_cliente_pct', 'tarifa_cliente_min']
let cache = null

/** Parámetros de cobro (ajustes_plataforma), con caché de 1 minuto. */
export async function ajustesCobro(cx) {
  if (cache && Date.now() - cache.t < 60_000) return cache.v
  const filas = await query('SELECT clave, valor FROM ajustes_plataforma', [], cx)
  const v = Object.fromEntries(filas.map((f) => [f.clave, Number(f.valor)]))
  cache = { t: Date.now(), v }
  return v
}

export async function guardarAjustesCobro(valores, cx) {
  for (const clave of PARAMETROS) {
    if (valores[clave] === undefined) continue
    await exec('UPDATE ajustes_plataforma SET valor = ? WHERE clave = ?', [round2(valores[clave]), clave], cx)
  }
  cache = null
}

/** Tarifa al cliente sobre un neto: % con mínimo (servicios) o solo % (materiales, cargos). */
export const tarifaCliente = (neto, pct, minimo = 0) => (neto > 0 && pct > 0 ? Math.max(round2(neto * pct / 100), minimo) : 0)

/** Membresía vigente del prestador (plan dirigido a Prestador; una cancelada sigue hasta el fin del periodo). */
export async function planPrestador(id_empleado, cx) {
  return one(
    `SELECT TOP 1 p.id_plan, p.nombre, p.comision_pct, p.prioridad_asignacion, p.destacado, s.id_suscripcion, s.estado, s.fecha_renovacion
       FROM empleados e JOIN clientes c ON c.id_usuario = e.id_usuario
       JOIN suscripciones s ON s.id_cliente = c.id_cliente JOIN planes p ON p.id_plan = s.id_plan
      WHERE e.id_empleado = ? AND p.dirigido_a = 'Prestador' AND s.estado IN ('Activa', 'Cancelada') AND s.fecha_renovacion >= ${HOY}
      ORDER BY s.fecha_inicio DESC`, [id_empleado], cx)
}

/** % de comisión del prestador: el de su membresía, o el general. */
export async function comisionPctDe(id_empleado, cx) {
  const plan = await planPrestador(id_empleado, cx)
  if (plan?.comision_pct != null) return Number(plan.comision_pct)
  return (await ajustesCobro(cx)).comision_pct
}

/** Valor del servicio para el prestador: precio de catálogo sin ITBIS (los descuentos de plan los absorbe la plataforma). */
async function valores(id_solicitud, cx) {
  const r = await one(
    `SELECT COALESCE(SUM(IIF(id_servicio IS NOT NULL, subtotal, 0)), 0) AS servicios,
            COALESCE(SUM(IIF(id_servicio IS NULL, subtotal, 0)), 0) AS materiales
       FROM solicitud_detalle WHERE id_solicitud = ?`, [id_solicitud], cx)
  return { servicios: round2(r.servicios), materiales: round2(r.materiales) }
}

/** Asignación vigente (aceptada o completada) de la solicitud. */
const asignacionVigente = (id_solicitud, cx) => one(
  `SELECT TOP 1 a.*, s.codigo_seguimiento FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
    WHERE a.id_solicitud = ? AND a.estado_asignacion IN ('Aceptada', 'Completada') ORDER BY a.id_asignacion DESC`, [id_solicitud], cx)

async function movimiento(cx, m) {
  if (!m.monto) return null
  await exec(
    `INSERT INTO movimientos_prestador (id_empleado, tipo, descripcion, monto, id_solicitud, id_asignacion, id_pago, id_liquidacion, id_reversado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id_empleado, m.tipo, m.descripcion.slice(0, 200), round2(m.monto), m.id_solicitud ?? null, m.id_asignacion ?? null,
      m.id_pago ?? null, m.id_liquidacion ?? null, m.id_reversado ?? null], cx)
}

/** Revierte los movimientos que cumplan la condición y aún no tengan reverso. */
async function reversar(cx, donde, params, motivo) {
  const filas = await query(
    `SELECT m.* FROM movimientos_prestador m WHERE ${donde} AND m.tipo <> 'Reverso'
        AND NOT EXISTS (SELECT 1 FROM movimientos_prestador r WHERE r.id_reversado = m.id_movimiento)`, params, cx)
  for (const m of filas) {
    await movimiento(cx, {
      id_empleado: m.id_empleado, tipo: 'Reverso', descripcion: `${motivo}: ${m.descripcion}`, monto: -Number(m.monto),
      id_solicitud: m.id_solicitud, id_reversado: m.id_movimiento,
    })
  }
  return filas.length
}

/**
 * Al aceptar la asignación: comisión del prestador = % del valor de los servicios, con el mínimo.
 * El % y el monto quedan fijados en la asignación.
 */
export async function cargarComision(cx, a) {
  const { servicios } = await valores(a.id_solicitud, cx)
  if (!(servicios > 0)) return null
  const pct = await comisionPctDe(a.id_empleado, cx)
  const minimo = (await ajustesCobro(cx)).comision_min
  const monto = Math.min(Math.max(round2(servicios * pct / 100), minimo), servicios)
  await exec('UPDATE asignaciones_servicio SET comision_pct = ?, comision_monto = ? WHERE id_asignacion = ?', [pct, monto, a.id_asignacion], cx)
  await movimiento(cx, {
    id_empleado: a.id_empleado, tipo: 'Comisión', id_solicitud: a.id_solicitud, id_asignacion: a.id_asignacion, monto: -monto,
    descripcion: `Comisión ${pct} % (mín. RD$ ${minimo.toFixed(2)}) · ${a.codigo_seguimiento}`,
  })
  return { pct, monto }
}

/**
 * Pago confirmado de una solicitud: lo que gana el prestador por esa parte, la comisión de los extras
 * (materiales, cargos) y, si lo cobró él en efectivo, el dinero que ya tiene en mano.
 *  - Anticipo: 50 % del valor de los servicios. Saldo: el resto + materiales. Total: todo. Cargo: el cargo.
 */
export async function movimientosDePago(cx, pago) {
  if (!pago.id_solicitud) return
  const a = await asignacionVigente(pago.id_solicitud, cx)
  if (!a || a.comision_pct == null) return // aceptada antes del modelo de comisiones
  const v = await valores(pago.id_solicitud, cx)
  const pct = Number(a.comision_pct)
  const base = { id_empleado: a.id_empleado, id_solicitud: pago.id_solicitud, id_pago: pago.id_pago }
  let ganado, extra = 0, concepto
  if (pago.tipo_pago === 'Cargo') {
    const c = await one('SELECT descripcion, cantidad, precio_unitario FROM cargos_adicionales WHERE id_cargo = ?', [pago.id_cargo], cx)
    ganado = extra = round2(Number(c.cantidad) * Number(c.precio_unitario))
    concepto = `Cargo adicional "${c.descripcion}"`
  } else if (pago.tipo_pago === 'Anticipo') {
    ganado = round2(v.servicios / 2)
    concepto = 'Anticipo 50 %'
  } else {
    // Saldo o pago único: lo que falta de los servicios (lo acreditado con el anticipo se descuenta) + materiales
    const previo = await one(
      `SELECT COALESCE(SUM(monto), 0) AS t FROM movimientos_prestador m WHERE m.id_solicitud = ? AND m.tipo = 'Servicio realizado' AND m.id_pago IS NOT NULL
          AND m.id_pago IN (SELECT id_pago FROM pagos WHERE tipo_pago = 'Anticipo' AND estado = 'Confirmado')`, [pago.id_solicitud], cx)
    ganado = round2(v.servicios - Number(previo.t) + v.materiales)
    extra = v.materiales
    concepto = pago.tipo_pago === 'Saldo' ? `Saldo 50 %${v.materiales ? ' + materiales' : ''}` : 'Pago completo'
  }
  await movimiento(cx, { ...base, tipo: 'Servicio realizado', monto: ganado, descripcion: `${concepto} · ${a.codigo_seguimiento}` })
  if (extra > 0) {
    await movimiento(cx, { ...base, tipo: 'Comisión extra', monto: -round2(extra * pct / 100), descripcion: `Comisión ${pct} % sobre ${pago.tipo_pago === 'Cargo' ? 'cargo adicional' : 'materiales'} · ${a.codigo_seguimiento}` })
  }
  if (pago.metodo_pago === 'Efectivo') {
    await movimiento(cx, { ...base, tipo: 'Efectivo cobrado', monto: -Number(pago.monto), descripcion: `Efectivo cobrado al cliente (recibo ${pago.referencia || 's/n'}) · ${a.codigo_seguimiento}` })
  }
}

/** Servicio cubierto por el plan del cliente (sin pagos): el prestador cobra su valor al finalizar. */
export async function acreditarSinPago(cx, id_solicitud) {
  const a = await asignacionVigente(id_solicitud, cx)
  if (!a || a.comision_pct == null) return
  if (await one("SELECT 1 AS x FROM pagos WHERE id_solicitud = ? AND estado = 'Confirmado'", [id_solicitud], cx)) return
  const v = await valores(id_solicitud, cx)
  await movimiento(cx, {
    id_empleado: a.id_empleado, tipo: 'Servicio realizado', id_solicitud, id_asignacion: a.id_asignacion,
    monto: round2(v.servicios + v.materiales), descripcion: `Servicio cubierto por el plan del cliente · ${a.codigo_seguimiento}`,
  })
}

/** Solicitud cancelada: se devuelve la comisión cobrada al aceptar (como en Freelancer al cancelar el proyecto). */
export const reversarComision = (cx, id_solicitud) =>
  reversar(cx, "m.id_solicitud = ? AND m.tipo = 'Comisión'", [id_solicitud], 'Solicitud cancelada')

/** Pago reembolsado al cliente: se revierte lo que el prestador ganó con él y su comisión extra. */
export const reversarPago = (cx, id_pago) =>
  reversar(cx, "m.id_pago = ? AND m.tipo IN ('Servicio realizado', 'Comisión extra')", [id_pago], 'Pago reembolsado')

/** Liquidación registrada por administración: pago al prestador (baja su saldo) o cobro al prestador (lo sube). */
export async function movimientoLiquidacion(cx, l) {
  await movimiento(cx, {
    id_empleado: l.id_empleado, tipo: 'Liquidación', id_liquidacion: l.id_liquidacion,
    monto: l.sentido === 'Pago al prestador' ? -l.monto : l.monto,
    descripcion: `${l.sentido} por ${l.metodo.toLowerCase()}${l.referencia ? ` (${l.referencia})` : ''}`,
  })
}

/** Saldo del prestador (> 0: la plataforma le debe; < 0: debe a la plataforma). */
export async function saldoPrestador(id_empleado, cx) {
  const r = await one('SELECT COALESCE(SUM(monto), 0) AS saldo FROM movimientos_prestador WHERE id_empleado = ?', [id_empleado], cx)
  return round2(r.saldo)
}
