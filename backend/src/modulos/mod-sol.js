// =====================================================================
// MOD-SOL · Gestión de Solicitudes (proceso 2.0)
// SOL-P01 Nueva solicitud · SOL-P02 Seguimiento · SOL-P03 Mis solicitudes · SOL-P04 Panel del prestador · SOL-P05 Asignación automática
// =====================================================================
import { exec, one, query, transaction, HOY, AHORA } from '../config/db.js'
import { notificar, notificarAdmins, auditar } from './mod-adm.js'
import { Router } from 'express'
import { autenticar, autenticarOpcional, soloRol } from '../middleware/auth.js'
import { badRequest, conflict, forbidden, notFound, validar } from '../lib/http.js'
import { codigoAleatorio } from '../lib/fiscal.js'
import { totalesSolicitud, cotizar, estadoCobro, textoCobro, SQL_DOCUMENTO_PAGO } from '../lib/totales.js'
import { ajustesCobro, cargarComision, reversarComision, acreditarSinPago } from '../lib/comisiones.js'

export const PLAZO_RESPUESTA_H = 2
// Cargo adicional: el prestador puede solicitarlo hasta 30 días después de finalizado el servicio
export const DIAS_CARGO_ADICIONAL = 30
export const MAX_REASIGNACIONES = 3
// El cliente puede calificar al prestador hasta 30 días después de finalizado el servicio
export const DIAS_CALIFICAR = 30

const normal = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Crea la asignación y avisa al prestador (app + WhatsApp) con plazo de 2 h. */
export async function asignarPrestador(cx, id_solicitud, id_empleado, tipo) {
  const r = await exec(
    `INSERT INTO asignaciones_servicio (id_solicitud, id_empleado, tipo_asignacion, estado_asignacion)
     VALUES (?, ?, ?, 'Asignada')`,
    [id_solicitud, id_empleado, tipo],
    cx,
  )
  const info = await one(
    `SELECT s.codigo_seguimiento, e.id_usuario FROM solicitudes_servicio s, empleados e
      WHERE s.id_solicitud = ? AND e.id_empleado = ?`,
    [id_solicitud, id_empleado],
    cx,
  )
  await notificar(info.id_usuario, {
    tipo: 'Solicitud',
    titulo: `Nueva asignación ${info.codigo_seguimiento}`,
    mensaje: `Tienes una nueva solicitud (${tipo.toLowerCase()}). Responde en un plazo de ${PLAZO_RESPUESTA_H} horas.`,
    canales: ['App', 'WhatsApp'],
  }, cx)
  return r.insertId
}

/**
 * Subproceso 2.3 · Asignación automática.
 * Candidatos: misma categoría, Aprobado, Disponible, zona que incluya la dirección,
 * sin otra cita en esa fecha/hora y no excluidos. Orden: quien ofrece el servicio, membresía con prioridad,
 * mejor calificación, menor carga semanal.
 */
export async function asignacionAutomatica(cx, id_solicitud) {
  const sol = await one(
    `SELECT s.*, (SELECT TOP 1 sv.id_categoria FROM solicitud_detalle d JOIN servicios sv ON sv.id_servicio = d.id_servicio
                   WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL ORDER BY d.id_detalle) AS id_categoria
       FROM solicitudes_servicio s WHERE s.id_solicitud = ?`,
    [id_solicitud],
    cx,
  )
  if (!sol || sol.estado !== 'Pendiente') return null

  const previas = await query('SELECT id_empleado, estado_asignacion FROM asignaciones_servicio WHERE id_solicitud = ?', [id_solicitud], cx)
  const rechazos = previas.filter((p) => p.estado_asignacion === 'Rechazada').length
  const excluidos = previas.map((p) => p.id_empleado)

  const alertar = async (motivo) => {
    await notificarAdmins({
      tipo: 'Solicitud',
      titulo: `Solicitud ${sol.codigo_seguimiento} sin prestador`,
      mensaje: `${motivo} Requiere asignación manual.`,
    }, cx)
    return null
  }
  if (rechazos >= MAX_REASIGNACIONES) return alertar(`Se alcanzó el máximo de ${MAX_REASIGNACIONES} reasignaciones automáticas.`)

  const candidatos = await query(
    `SELECT e.id_empleado, e.zona_cobertura, e.calificacion_promedio,
            -- cuántos de los servicios pedidos ofrece el prestador (empleado_servicio)
            (SELECT COUNT(*) FROM empleado_servicio es WHERE es.id_empleado = e.id_empleado
               AND es.id_servicio IN (SELECT d.id_servicio FROM solicitud_detalle d WHERE d.id_solicitud = ? AND d.id_servicio IS NOT NULL)) AS ofrece,
            (SELECT COUNT(*) FROM asignaciones_servicio a2 JOIN solicitudes_servicio s2 ON s2.id_solicitud = a2.id_solicitud
              WHERE a2.id_empleado = e.id_empleado AND a2.estado_asignacion IN ('Asignada','Aceptada','Completada')
                AND DATEDIFF(WEEK, s2.fecha_preferida, ?) = 0) AS carga_semana,
            -- membresía vigente con prioridad en la asignación
            (SELECT COUNT(*) FROM clientes cm JOIN suscripciones sm ON sm.id_cliente = cm.id_cliente JOIN planes pm ON pm.id_plan = sm.id_plan
              WHERE cm.id_usuario = e.id_usuario AND pm.dirigido_a = 'Prestador' AND pm.prioridad_asignacion = 1
                AND sm.estado IN ('Activa','Cancelada') AND sm.fecha_renovacion >= CAST(GETDATE() AS date)) AS prioridad
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
      WHERE e.id_categoria = ? AND e.estado_aprobacion = 'Aprobado' AND e.estado_disponibilidad = 'Disponible'
        AND u.estado = 'Activo'
        ${excluidos.length ? 'AND e.id_empleado NOT IN (?)' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
           WHERE a.id_empleado = e.id_empleado AND a.estado_asignacion IN ('Asignada','Aceptada')
             AND s.fecha_preferida = ? AND (s.hora_preferida = ? OR (s.hora_preferida IS NULL AND ? IS NULL)))
      ORDER BY ofrece DESC, prioridad DESC, e.calificacion_promedio DESC, carga_semana ASC`,
    excluidos.length
      ? [id_solicitud, sol.fecha_preferida, sol.id_categoria, excluidos, sol.fecha_preferida, sol.hora_preferida, sol.hora_preferida]
      : [id_solicitud, sol.fecha_preferida, sol.id_categoria, sol.fecha_preferida, sol.hora_preferida, sol.hora_preferida],
    cx,
  )

  // Zona de cobertura: solo aplica a servicios En sitio
  const dir = normal(sol.direccion_servicio || '')
  const enZona = (c) =>
    sol.modalidad !== 'En sitio' ||
    (c.zona_cobertura || '').split(',').map((z) => normal(z.trim())).some((z) => z && dir.includes(z))
  // Primero quien ofrece el servicio pedido; si nadie lo ofrece, otro prestador de la misma categoría
  const elegido = candidatos.find((c) => c.ofrece > 0 && enZona(c)) || candidatos.find(enZona)
  if (!elegido) return alertar('No hay prestadores disponibles que cumplan categoría, zona y horario.')

  await asignarPrestador(cx, id_solicitud, elegido.id_empleado, 'Automática')
  return elegido.id_empleado
}

/** Recalcula empleados.calificacion_promedio con las calificaciones registradas. */
export async function recalcularCalificacion(cx, id_empleado) {
  await exec(
    `UPDATE e SET e.calificacion_promedio = CAST(ROUND(x.prom, 1) AS DECIMAL(2,1)), e.total_resenas = x.n
       FROM empleados e
       JOIN (SELECT id_empleado, AVG(CAST(calificacion_cliente AS DECIMAL(4,2))) prom, COUNT(*) n FROM asignaciones_servicio
              WHERE id_empleado = ? AND calificacion_cliente IS NOT NULL GROUP BY id_empleado) x
         ON x.id_empleado = e.id_empleado`,
    [id_empleado],
    cx,
  )
}

const rSolicitudes = Router()
const MAX_SERVICIOS = 5
const HORAS_CANCELACION = 12
// Fecha local (America/Santo_Domingo) en formato yyyy-mm-dd
const diaLocal = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
const hoy = () => diaLocal()

const SQL_SOLICITUD = `
  SELECT s.*, c.id_usuario AS id_usuario_cliente, CONCAT(uc.nombre, ' ', uc.apellido) AS cliente,
         a.id_asignacion, a.id_empleado, a.tipo_asignacion, a.estado_asignacion, a.fecha_asignacion, a.fecha_completado,
         a.calificacion_cliente, a.comentario_cliente, CONCAT(ue.nombre, ' ', ue.apellido) AS prestador,
         ue.telefono AS telefono_prestador, e.especialidad, e.calificacion_promedio, e.id_usuario AS id_usuario_prestador
    FROM solicitudes_servicio s
    JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios uc ON uc.id_usuario = c.id_usuario
    LEFT JOIN asignaciones_servicio a ON a.id_asignacion = (
      SELECT TOP 1 a2.id_asignacion FROM asignaciones_servicio a2 WHERE a2.id_solicitud = s.id_solicitud
       ORDER BY CASE WHEN a2.estado_asignacion = 'Rechazada' THEN 1 ELSE 0 END, a2.id_asignacion DESC)
    LEFT JOIN empleados e ON e.id_empleado = a.id_empleado
    LEFT JOIN usuarios ue ON ue.id_usuario = e.id_usuario`

async function cargarSolicitud(codigo, cx) {
  const s = await one(`${SQL_SOLICITUD} WHERE s.codigo_seguimiento = ?`, [codigo], cx)
  if (!s) throw notFound('Solicitud no encontrada')
  return s
}

const esDueno = (req, s) => req.usuario?.id_cliente === s.id_cliente
const esPrestador = (req, s) => req.usuario?.id_empleado && req.usuario.id_empleado === s.id_empleado && s.estado_asignacion !== 'Rechazada'
const esAdmin = (req) => req.usuario?.nombre_rol === 'Administrador'
/** Finalizado (por el cliente o automáticamente), sin calificar y dentro del plazo. */
const puedeCalificar = (s) => s.estado === 'Completado' && s.estado_asignacion === 'Completada' && s.calificacion_cliente == null &&
  (!s.fecha_finalizacion || Date.now() - new Date(s.fecha_finalizacion).getTime() <= DIAS_CALIFICAR * 864e5)

async function codigoUnico(cx) {
  for (let i = 0; i < 10; i++) {
    const c = `SOL-${codigoAleatorio(6)}`
    if (!(await one('SELECT 1 FROM solicitudes_servicio WHERE codigo_seguimiento = ?', [c], cx))) return c
  }
  throw new Error('No se pudo generar el código de seguimiento')
}

// ---------- SOL-P01 · Nueva solicitud (proceso 2.0) ----------
rSolicitudes.post('/', autenticar, soloRol('Cliente'), async (req, res) => {
  const b = req.body
  const lineas = Array.isArray(b.servicios) ? b.servicios : []
  const fecha = String(b.fecha_preferida || '')
  const maxFecha = diaLocal(new Date(Date.now() + 90 * 864e5))
  validar({
    servicios: (!lineas.length || lineas.length > MAX_SERVICIOS) && `Seleccione entre 1 y ${MAX_SERVICIOS} servicios`,
    cantidad: lineas.some((l) => !(Number.isInteger(Number(l.cantidad)) && l.cantidad >= 1 && l.cantidad <= 99)) && 'Cantidad inválida',
    fecha_preferida: !(fecha >= hoy() && fecha <= maxFecha) && 'Seleccione una fecha válida',
    modalidad: !['En sitio', 'Remoto', 'Virtual'].includes(b.modalidad) && 'Seleccione la modalidad',
    direccion_servicio: b.modalidad === 'En sitio' && !(String(b.direccion_servicio || '').trim().length >= 10) && 'Indique la dirección del servicio',
    politica: !b.acepta_politica && 'Debe aceptar la política de cancelación',
  })

  const resultado = await transaction(async (cx) => {
    const ids = lineas.map((l) => Number(l.id_servicio))
    const servicios = await query("SELECT * FROM servicios WHERE id_servicio IN (?) AND estado = 'Publicado'", [ids], cx)
    if (servicios.length !== new Set(ids).size) throw badRequest('Uno de los servicios no está disponible')
    if (b.modalidad === 'En sitio' && servicios.some((s) => s.modalidad === 'Remoto')) throw badRequest('Un servicio seleccionado solo se ofrece de forma remota')
    if (b.modalidad !== 'En sitio' && servicios.some((s) => s.modalidad === 'En sitio')) throw badRequest('Un servicio seleccionado solo se ofrece en sitio')

    const codigo = await codigoUnico(cx)
    // La tarifa de la plataforma queda fijada en la solicitud (un cambio posterior no altera sus cobros)
    const cobro = await ajustesCobro(cx)
    const sol = await exec(
      `INSERT INTO solicitudes_servicio (id_cliente, codigo_seguimiento, fecha_preferida, hora_preferida, modalidad, direccion_servicio, descripcion_problema, tarifa_pct, tarifa_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.usuario.id_cliente, codigo, fecha, b.hora_preferida || null, b.modalidad, b.direccion_servicio?.trim() || null, b.descripcion_problema?.trim() || null,
        cobro.tarifa_cliente_pct, cobro.tarifa_cliente_min],
      cx,
    )
    for (const l of lineas) {
      const s = servicios.find((x) => x.id_servicio === Number(l.id_servicio))
      const cant = Number(l.cantidad)
      await exec(
        `INSERT INTO solicitud_detalle (id_solicitud, id_servicio, cantidad, precio_unitario, subtotal, aplica_itbis) VALUES (?, ?, ?, ?, ?, ?)`,
        [sol.insertId, s.id_servicio, cant, s.precio_base, Number(s.precio_base) * cant, s.aplica_itbis],
        cx,
      )
    }

    // SOL-P05 · Asignación: manual si eligió prestador (v_prestadorSeleccionado), si no automática
    let asignado
    if (b.id_empleado) {
      const e = await one(
        `SELECT e.id_empleado FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
          WHERE e.id_empleado = ? AND e.estado_aprobacion = 'Aprobado' AND u.estado = 'Activo'`,
        [b.id_empleado], cx,
      )
      if (!e) throw badRequest('El prestador seleccionado no está disponible')
      await asignarPrestador(cx, sol.insertId, e.id_empleado, 'Manual')
      asignado = e.id_empleado
    } else {
      asignado = await asignacionAutomatica(cx, sol.insertId)
    }
    await notificar(req.usuario.id_usuario, {
      tipo: 'Solicitud', titulo: `Solicitud ${codigo} registrada`,
      mensaje: `Sigue tu solicitud con el código ${codigo}.`, canales: ['App', 'Correo', 'WhatsApp'],
    }, cx)
    return { id_solicitud: sol.insertId, codigo, asignado }
  })

  const totales = await totalesSolicitud(resultado.id_solicitud)
  res.status(201).json({ codigo_seguimiento: resultado.codigo, estado: 'Pendiente', prestador_asignado: !!resultado.asignado, plazo_respuesta_h: PLAZO_RESPUESTA_H, totales })
})

// Total estimado antes de enviar (paso 4): v_totalPagar con plan e ITBIS
rSolicitudes.post('/cotizar', autenticar, soloRol('Cliente'), async (req, res) => {
  const lineas = Array.isArray(req.body.servicios) ? req.body.servicios : []
  if (!lineas.length) throw badRequest('Seleccione al menos un servicio')
  const servicios = await query("SELECT * FROM servicios WHERE id_servicio IN (?) AND estado = 'Publicado'", [lineas.map((l) => Number(l.id_servicio))])
  const items = lineas.map((l) => {
    const s = servicios.find((x) => x.id_servicio === Number(l.id_servicio))
    if (!s) throw badRequest('Uno de los servicios no está disponible')
    return { ...s, cantidad: Math.min(Math.max(Number(l.cantidad) || 1, 1), 99) }
  })
  res.json(await cotizar(req.usuario.id_cliente, items))
})

// ---------- SOL-P03 · Mis solicitudes ----------
rSolicitudes.get('/mias', autenticar, soloRol('Cliente'), async (req, res) => {
  const filas = await query(
    `${SQL_SOLICITUD} WHERE s.id_cliente = ? ${req.query.estado ? 'AND s.estado = ?' : ''} ORDER BY s.fecha_solicitud DESC`,
    req.query.estado ? [req.usuario.id_cliente, req.query.estado] : [req.usuario.id_cliente],
  )
  const out = []
  for (const s of filas) {
    const cobro = await estadoCobro(s.id_solicitud)
    const servicios = await query(
      'SELECT COALESCE(sv.nombre, d.descripcion) AS nombre FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = ? AND d.id_servicio IS NOT NULL',
      [s.id_solicitud],
    )
    out.push({
      codigo: s.codigo_seguimiento, servicio: servicios.map((x) => x.nombre).join(', '),
      prestador: s.prestador || (s.estado === 'Cancelado' ? null : 'Asignación automática'),
      fecha: s.fecha_preferida, total: cobro.total_servicio, estado: s.estado, pago: textoCobro(cobro),
      por_pagar: cobro.siguiente ? { tipo: cobro.siguiente, monto: cobro.monto_siguiente } : null,
      // El anticipo y el saldo comparten la factura del servicio: se lista una vez
      calificar: puedeCalificar(s),
      facturas: cobro.pagos.filter((p, i, t) => p.numero_factura && t.findIndex((x) => x.numero_factura === p.numero_factura) === i)
        .map((p) => ({ tipo: p.tipo_pago, numero: p.numero_factura })),
    })
  }
  res.json(out)
})

// ---------- SOL-P02 · Seguimiento (visitante con código: sin datos personales) ----------
rSolicitudes.get('/seguimiento/:codigo', autenticarOpcional, async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  const completo = esDueno(req, s) || esPrestador(req, s) || esAdmin(req)
  const detalle = await query(
    `SELECT d.id_detalle, d.id_servicio, COALESCE(d.descripcion, sv.nombre) AS descripcion, d.cantidad, d.precio_unitario, d.subtotal, sv.modalidad
       FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = ? ORDER BY d.id_detalle`,
    [s.id_solicitud],
  )
  const totales = await totalesSolicitud(s.id_solicitud)
  const asignaciones = await query(
    `SELECT a.fecha_asignacion, a.tipo_asignacion, a.estado_asignacion, CONCAT(u.nombre, ' ', u.apellido) AS prestador
       FROM asignaciones_servicio a JOIN empleados e ON e.id_empleado = a.id_empleado JOIN usuarios u ON u.id_usuario = e.id_usuario
      WHERE a.id_solicitud = ? ORDER BY a.id_asignacion`,
    [s.id_solicitud],
  )
  const cobro = await estadoCobro(s.id_solicitud)
  const pagos = await query(
    `SELECT p.id_pago, p.tipo_pago, p.estado, p.metodo_pago, p.monto, p.fecha_pago, f.numero_factura, ec.ncf, ec.estado_dgii
       FROM pagos p OUTER APPLY (${SQL_DOCUMENTO_PAGO}) f LEFT JOIN ecf ec ON ec.id_factura = f.id_factura
      WHERE p.id_solicitud = ? AND p.estado IN ('En verificación', 'Confirmado') ORDER BY p.id_pago`,
    [s.id_solicitud],
  )

  // Historial de eventos
  const historial = [{ evento: 'Solicitud registrada', fecha: s.fecha_solicitud }]
  for (const a of asignaciones) {
    historial.push({ evento: `Asignada a ${completo ? a.prestador : 'un prestador'} (${a.tipo_asignacion.toLowerCase()})`, fecha: a.fecha_asignacion })
    if (a.estado_asignacion === 'Rechazada') historial.push({ evento: 'Prestador no disponible, se reasigna', fecha: null })
  }
  if (['Aceptada', 'Completada'].includes(s.estado_asignacion)) historial.push({ evento: 'Prestador aceptó la solicitud', fecha: null })
  const concepto = { Total: 'Pago', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }
  const vistos = new Set()
  const eventoPago = (p) => {
    historial.push({ evento: `${concepto[p.tipo_pago]} ${p.estado === 'Confirmado' ? 'confirmado' : 'en verificación'} (${p.metodo_pago})`, fecha: p.fecha_pago })
    if (!p.ncf) return
    // El saldo se abona a la factura emitida con el anticipo
    if (vistos.has(p.ncf)) historial.push({ evento: `Abonado a la factura ${p.ncf}`, fecha: null })
    else historial.push({ evento: `${p.ncf.startsWith('E33') ? 'Nota de débito' : 'Factura'} ${p.ncf} · ${p.estado_dgii}`, fecha: null })
    vistos.add(p.ncf)
  }
  pagos.filter((p) => p.tipo_pago === 'Anticipo').forEach(eventoPago)
  if (s.fecha_completado) historial.push({ evento: 'Prestador marcó el servicio completado', fecha: s.fecha_completado })
  if (s.fecha_finalizacion) historial.push({ evento: 'Cliente confirmó la finalización', fecha: s.fecha_finalizacion })
  pagos.filter((p) => !['Anticipo', 'Cargo'].includes(p.tipo_pago)).forEach(eventoPago)
  for (const c of cobro.cargos) {
    historial.push({ evento: `Prestador solicitó un cargo adicional: ${c.descripcion}`, fecha: c.fecha_solicitud })
    if (['Aceptado', 'Pagado', 'Rechazado'].includes(c.estado)) {
      historial.push({ evento: `Cliente ${c.estado === 'Rechazado' ? 'rechazó' : 'aceptó'} el cargo adicional`, fecha: c.fecha_respuesta })
    }
    const pc = pagos.find((p) => p.id_pago === c.pago?.id_pago)
    if (pc) eventoPago(pc)
  }
  if (s.estado === 'Cancelado') historial.push({ evento: `Cancelada${s.motivo_cancelacion ? `: ${s.motivo_cancelacion}` : ''}`, fecha: null })

  const final = cobro.total || cobro.saldo
  const etapa =
    s.estado === 'Completado' && cobro.cubierto_por_plan ? 'Cubierto por plan'
      : final?.estado === 'Confirmado' ? (pagos.every((p) => p.estado !== 'Confirmado' || p.ncf) ? 'Facturado' : 'Pagado')
        : s.estado === 'Completado' ? 'Completado'
          : s.estado === 'En proceso' ? (cobro.anticipo ? 'En proceso' : 'Aceptado') : s.estado

  const inicioCita = new Date(`${s.fecha_preferida}T${s.hora_preferida || '00:00:00'}`)
  res.json({
    codigo: s.codigo_seguimiento, estado: s.estado, etapa, fecha_solicitud: s.fecha_solicitud,
    fecha_preferida: s.fecha_preferida, hora_preferida: s.hora_preferida, modalidad: s.modalidad,
    servicios: detalle.map((d) => d.descripcion), historial, totales: { subtotal: totales.subtotal, descuento: totales.descuento, itbis: totales.itbis, total: totales.total },
    ...(completo && {
      cliente: s.cliente, direccion_servicio: s.direccion_servicio, descripcion_problema: s.descripcion_problema, detalle,
      asignacion: s.id_asignacion ? {
        id_asignacion: s.id_asignacion, estado: s.estado_asignacion, tipo: s.tipo_asignacion, prestador: s.prestador,
        especialidad: s.especialidad, calificacion: s.calificacion_promedio, telefono: s.telefono_prestador,
        fecha_completado: s.fecha_completado, calificacion_cliente: s.calificacion_cliente,
      } : null,
      pagos,
      cobro: {
        total_servicio: cobro.total_servicio, siguiente: cobro.siguiente, monto_siguiente: cobro.monto_siguiente ?? null, motivo: cobro.motivo,
        anticipo: cobro.anticipo ? { monto: cobro.anticipo.monto, estado: cobro.anticipo.estado } : null,
        saldo: cobro.saldo ? { monto: cobro.saldo.monto, estado: cobro.saldo.estado } : null,
        total: cobro.total ? { monto: cobro.total.monto, estado: cobro.total.estado } : null,
      },
      cargos: cobro.cargos.map((c) => ({
        id_cargo: c.id_cargo, descripcion: c.descripcion, motivo: c.motivo, cantidad: c.cantidad, precio_unitario: c.precio_unitario,
        aplica_itbis: !!c.aplica_itbis, total: c.total, estado: c.estado, fecha_solicitud: c.fecha_solicitud, motivo_rechazo: c.motivo_rechazo,
        pago: c.pago ? { estado: c.pago.estado, numero_factura: c.pago.numero_factura } : null,
      })),
      puede: {
        confirmar: esDueno(req, s) && s.estado === 'En proceso' && s.estado_asignacion === 'Completada',
        calificar: esDueno(req, s) && puedeCalificar(s),
        pagar: esDueno(req, s) && !!cobro.siguiente,
        responder_cargo: esDueno(req, s),
        cancelar: (esDueno(req, s) || esAdmin(req)) && ['Pendiente', 'En proceso'].includes(s.estado) &&
          (esAdmin(req) || s.estado === 'Pendiente' || inicioCita - Date.now() > HORAS_CANCELACION * 3600e3),
      },
    }),
  })
})

// ---------- Cancelaciones ----------
rSolicitudes.post('/:codigo/cancelar', autenticar, async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  const admin = esAdmin(req)
  if (!admin && !esDueno(req, s)) throw forbidden()
  if (!['Pendiente', 'En proceso'].includes(s.estado)) throw conflict('La solicitud ya no se puede cancelar')
  const inicio = new Date(`${s.fecha_preferida}T${s.hora_preferida || '00:00:00'}`)
  if (!admin && s.estado !== 'Pendiente' && inicio - Date.now() <= HORAS_CANCELACION * 3600e3) {
    throw conflict(`Solo puede cancelar sin costo mientras esté Pendiente o hasta ${HORAS_CANCELACION} horas antes de la cita`)
  }
  const motivo = String(req.body.motivo || '').trim()
  if (admin && !motivo) throw badRequest('Indique el motivo de la cancelación')
  await transaction(async (cx) => {
    await exec("UPDATE solicitudes_servicio SET estado = 'Cancelado', motivo_cancelacion = ? WHERE id_solicitud = ?", [motivo || 'Cancelada por el cliente', s.id_solicitud], cx)
    await exec("UPDATE asignaciones_servicio SET estado_asignacion = 'Rechazada' WHERE id_solicitud = ? AND estado_asignacion IN ('Asignada','Aceptada')", [s.id_solicitud], cx)
    await reversarComision(cx, s.id_solicitud)
    if (s.id_usuario_prestador) await notificar(s.id_usuario_prestador, { tipo: 'Solicitud', titulo: `Solicitud ${s.codigo_seguimiento} cancelada`, mensaje: motivo || 'El cliente canceló la solicitud.', canales: ['App', 'WhatsApp'] }, cx)
    if (admin) await notificar(s.id_usuario_cliente, { tipo: 'Solicitud', titulo: `Solicitud ${s.codigo_seguimiento} cancelada`, mensaje: motivo, canales: ['App', 'Correo'] }, cx)
    await auditar(req, 'Solicitud cancelada', 'solicitudes_servicio', s.id_solicitud, { estado: s.estado }, { estado: 'Cancelado', motivo }, cx)
    // Si ya había anticipo, administración debe reembolsarlo
    const anticipo = await one("SELECT id_pago, monto, estado FROM pagos WHERE id_solicitud = ? AND tipo_pago = 'Anticipo' AND estado IN ('Confirmado','En verificación')", [s.id_solicitud], cx)
    if (anticipo) {
      await notificarAdmins({ tipo: 'Pago', titulo: `Reembolsar anticipo · ${s.codigo_seguimiento}`, mensaje: `La solicitud se canceló con un anticipo ${anticipo.estado.toLowerCase()} de RD$ ${Number(anticipo.monto).toFixed(2)} (PAG-${String(anticipo.id_pago).padStart(4, '0')}).` }, cx)
    }
  })
  res.json({ ok: true })
})

// ---------- Cargo adicional: el cliente lo acepta (y luego lo paga) o lo rechaza ----------
rSolicitudes.post('/:codigo/cargos/:id/responder', autenticar, soloRol('Cliente'), async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  if (!esDueno(req, s)) throw forbidden()
  const decision = req.body.decision
  const motivo = String(req.body.motivo || '').trim().slice(0, 200)
  if (!['Aceptar', 'Rechazar'].includes(decision)) throw badRequest('Decisión inválida')
  const out = await transaction(async (cx) => {
    const c = await one('SELECT * FROM cargos_adicionales WITH (UPDLOCK, ROWLOCK) WHERE id_cargo = ? AND id_solicitud = ?', [req.params.id, s.id_solicitud], cx)
    if (!c) throw notFound('Cargo no encontrado')
    if (c.estado !== 'Pendiente') throw conflict(`El cargo ya está ${c.estado.toLowerCase()}`)
    const estado = decision === 'Aceptar' ? 'Aceptado' : 'Rechazado'
    await exec(`UPDATE cargos_adicionales SET estado = ?, fecha_respuesta = ${AHORA}, motivo_rechazo = ? WHERE id_cargo = ?`,
      [estado, estado === 'Rechazado' ? motivo || null : null, c.id_cargo], cx)
    const pr = await one('SELECT id_usuario FROM empleados WHERE id_empleado = ?', [c.id_empleado], cx)
    await notificar(pr.id_usuario, {
      tipo: 'Solicitud', titulo: `Cargo adicional ${estado.toLowerCase()} · ${s.codigo_seguimiento}`,
      mensaje: estado === 'Aceptado'
        ? `${s.cliente} aceptó el cargo "${c.descripcion}". Puede pagarlo en línea o puedes cobrarlo en efectivo.`
        : `${s.cliente} rechazó el cargo "${c.descripcion}".${motivo ? ` Motivo: ${motivo}` : ''}`,
      canales: ['App', 'WhatsApp'],
    }, cx)
    await auditar(req, `Cargo adicional ${estado.toLowerCase()}`, 'cargos_adicionales', c.id_cargo, { estado: 'Pendiente' }, { estado, motivo: motivo || null }, cx)
    return { estado }
  })
  const cobro = await estadoCobro(s.id_solicitud)
  res.json({ ...out, por_pagar: cobro.siguiente === 'Cargo' ? { tipo: 'Cargo', monto: cobro.monto_siguiente } : null })
})

// ---------- Confirmar finalización y calificar (cliente) ----------
rSolicitudes.post('/:codigo/confirmar', autenticar, soloRol('Cliente'), async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  if (!esDueno(req, s)) throw forbidden()
  if (s.estado !== 'En proceso' || s.estado_asignacion !== 'Completada') throw conflict('El prestador aún no ha marcado el servicio como completado')
  const cal = Number(req.body.calificacion)
  validar({ calificacion: !(Number.isInteger(cal) && cal >= 1 && cal <= 5) && 'Seleccione de 1 a 5 estrellas' })
  await transaction(async (cx) => {
    await exec('UPDATE asignaciones_servicio SET calificacion_cliente = ?, comentario_cliente = ? WHERE id_asignacion = ?',
      [cal, String(req.body.comentario || '').slice(0, 300) || null, s.id_asignacion], cx)
    await exec(`UPDATE solicitudes_servicio SET estado = 'Completado', fecha_finalizacion = ${AHORA} WHERE id_solicitud = ?`, [s.id_solicitud], cx)
    if ((await estadoCobro(s.id_solicitud, cx)).cubierto_por_plan) await acreditarSinPago(cx, s.id_solicitud)
    await recalcularCalificacion(cx, s.id_empleado)
    await notificar(s.id_usuario_prestador, { tipo: 'Solicitud', titulo: `${s.cliente} te calificó con ${cal} estrellas`, mensaje: `Solicitud ${s.codigo_seguimiento} confirmada.` }, cx)
  })
  res.json({ ok: true, estado: 'Completado' })
})

// ---------- Calificar al prestador después de finalizado (confirmación automática o si no lo hizo al confirmar) ----------
rSolicitudes.post('/:codigo/calificar', autenticar, soloRol('Cliente'), async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  if (!esDueno(req, s)) throw forbidden()
  const cal = Number(req.body.calificacion)
  validar({ calificacion: !(Number.isInteger(cal) && cal >= 1 && cal <= 5) && 'Seleccione de 1 a 5 estrellas' })
  if (s.calificacion_cliente != null) throw conflict('Ya calificaste este servicio')
  if (!puedeCalificar(s)) throw conflict(`Solo se califica un servicio finalizado, hasta ${DIAS_CALIFICAR} días después`)
  await transaction(async (cx) => {
    await exec('UPDATE asignaciones_servicio SET calificacion_cliente = ?, comentario_cliente = ? WHERE id_asignacion = ? AND calificacion_cliente IS NULL',
      [cal, String(req.body.comentario || '').trim().slice(0, 300) || null, s.id_asignacion], cx)
    await recalcularCalificacion(cx, s.id_empleado)
    await notificar(s.id_usuario_prestador, { tipo: 'Solicitud', titulo: `${s.cliente} te calificó con ${cal} estrellas`, mensaje: `Solicitud ${s.codigo_seguimiento}.` }, cx)
  })
  res.json({ ok: true, calificacion: cal })
})

// =====================================================================
// Prestador (SOL-P04)
// =====================================================================
export const rPrestador = Router()
rPrestador.use(autenticar, soloRol('Empleado'))

rPrestador.get('/panel', async (req, res) => {
  const id = req.usuario.id_empleado
  const e = await one('SELECT calificacion_promedio, total_resenas, estado_disponibilidad FROM empleados WHERE id_empleado = ?', [id])
  const nuevas = await query(
    `${SQL_SOLICITUD} WHERE a.id_empleado = ? AND a.estado_asignacion = 'Asignada' ORDER BY a.fecha_asignacion`, [id])
  const agenda = await query(
    `${SQL_SOLICITUD} WHERE a.id_empleado = ? AND a.estado_asignacion IN ('Aceptada','Completada') AND s.fecha_preferida = ${HOY}
      AND s.estado IN ('En proceso','Completado') ORDER BY s.hora_preferida`, [id])
  const mes = await one(
    `SELECT COUNT(*) n FROM asignaciones_servicio WHERE id_empleado = ? AND estado_asignacion = 'Completada'
      AND YEAR(fecha_completado) = YEAR(GETDATE()) AND MONTH(fecha_completado) = MONTH(GETDATE())`, [id])
  const conServicios = async (lista) => {
    const out = []
    for (const s of lista) {
      const cobro = await estadoCobro(s.id_solicitud)
      const det = await query('SELECT COALESCE(d.descripcion, sv.nombre) AS nombre, d.cantidad FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = ?', [s.id_solicitud])
      out.push({
        id_asignacion: s.id_asignacion, codigo: s.codigo_seguimiento, tipo: s.tipo_asignacion, estado_asignacion: s.estado_asignacion,
        estado: s.estado, servicio: det.map((d) => `${d.nombre}${d.cantidad > 1 ? ` × ${d.cantidad}` : ''}`).join(', '),
        cliente: s.cliente, direccion: s.direccion_servicio, fecha: s.fecha_preferida, hora: s.hora_preferida,
        descripcion: s.descripcion_problema, total: cobro.total_servicio, pago: textoCobro(cobro), anticipo_listo: cobro.anticipo_listo,
        cobro_efectivo: cobro.siguiente ? { tipo: cobro.siguiente, monto: cobro.monto_siguiente } : null,
        vence: s.estado_asignacion === 'Asignada' ? new Date(new Date(s.fecha_asignacion).getTime() + PLAZO_RESPUESTA_H * 3600e3).toISOString() : null,
      })
    }
    return out
  }
  res.json({
    disponibilidad: e.estado_disponibilidad,
    kpis: { hoy: agenda.length, por_aceptar: nuevas.length, completados_mes: mes.n, calificacion: e.calificacion_promedio, resenas: e.total_resenas },
    nuevas: await conServicios(nuevas),
    agenda: await conServicios(agenda),
  })
})

rPrestador.get('/asignaciones', async (req, res) => {
  const rows = await query(
    `SELECT a.id_asignacion, a.tipo_asignacion, a.estado_asignacion, s.codigo_seguimiento AS codigo, s.fecha_preferida, s.hora_preferida,
            s.estado, s.id_solicitud, s.fecha_finalizacion, CONCAT(u.nombre, ' ', u.apellido) AS cliente, s.direccion_servicio
       FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
       JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
      WHERE a.id_empleado = ? ${req.query.estado ? 'AND a.estado_asignacion = ?' : ''}
      ORDER BY a.fecha_asignacion DESC, a.id_asignacion DESC`, // la más reciente primero
    req.query.estado ? [req.usuario.id_empleado, req.query.estado] : [req.usuario.id_empleado],
  )
  for (const a of rows) {
    const cobro = await estadoCobro(a.id_solicitud)
    a.total = cobro.total_servicio
    a.pago = textoCobro(cobro)
    a.anticipo_listo = cobro.anticipo_listo
    a.cobro_efectivo = cobro.siguiente ? { tipo: cobro.siguiente, monto: cobro.monto_siguiente } : null
    a.cargos = cobro.cargos.map((c) => ({ id_cargo: c.id_cargo, descripcion: c.descripcion, total: c.total, estado: c.estado, pagado: c.pago?.estado || null }))
    a.cargo_bloqueo = puedeSolicitarCargo(a, cobro)
    a.puede_cargo = !a.cargo_bloqueo
    a.servicio = (await query('SELECT COALESCE(sv.nombre, d.descripcion) n FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = ? AND d.id_servicio IS NOT NULL', [a.id_solicitud])).map((x) => x.n).join(', ')
  }
  res.json(rows)
})

async function asignacionPropia(req, cx) {
  const a = await one(
    `SELECT a.*, s.codigo_seguimiento, s.estado AS estado_solicitud, c.id_usuario AS id_usuario_cliente
       FROM asignaciones_servicio a WITH (UPDLOCK, ROWLOCK) JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
       JOIN clientes c ON c.id_cliente = s.id_cliente
      WHERE a.id_asignacion = ?`,
    [req.params.id], cx,
  )
  if (!a) throw notFound('Asignación no encontrada')
  if (a.id_empleado !== req.usuario.id_empleado) throw forbidden()
  return a
}

rPrestador.post('/asignaciones/:id/aceptar', async (req, res) => {
  let comision = null
  await transaction(async (cx) => {
    const a = await asignacionPropia(req, cx)
    if (a.estado_asignacion !== 'Asignada') throw conflict('La asignación ya no está pendiente')
    await exec("UPDATE asignaciones_servicio SET estado_asignacion = 'Aceptada' WHERE id_asignacion = ?", [a.id_asignacion], cx)
    await exec("UPDATE solicitudes_servicio SET estado = 'En proceso' WHERE id_solicitud = ?", [a.id_solicitud], cx)
    // Como en Freelancer: la comisión se carga al aceptar el trabajo (se devuelve si la solicitud se cancela)
    comision = await cargarComision(cx, { ...a, codigo_seguimiento: a.codigo_seguimiento })
    await notificar(a.id_usuario_cliente, { tipo: 'Solicitud', titulo: `${req.usuario.nombre} ${req.usuario.apellido} aceptó tu solicitud ${a.codigo_seguimiento}`, mensaje: 'Paga el anticipo del 50 % para confirmar la visita. El 50 % restante se paga al finalizar el servicio.', canales: ['App', 'WhatsApp'] }, cx)
  })
  res.json({ ok: true, comision })
})

rPrestador.post('/asignaciones/:id/rechazar', async (req, res) => {
  await transaction(async (cx) => {
    const a = await asignacionPropia(req, cx)
    if (a.estado_asignacion !== 'Asignada') throw conflict('La asignación ya no está pendiente')
    await exec("UPDATE asignaciones_servicio SET estado_asignacion = 'Rechazada' WHERE id_asignacion = ?", [a.id_asignacion], cx)
    await asignacionAutomatica(cx, a.id_solicitud) // reasigna excluyendo a este prestador
  })
  res.json({ ok: true })
})

// Marcar completado; puede agregar materiales como líneas adicionales
rPrestador.post('/asignaciones/:id/completar', async (req, res) => {
  const materiales = Array.isArray(req.body.materiales) ? req.body.materiales : []
  validar({
    materiales: materiales.some((m) => !String(m.descripcion || '').trim() || !(Number(m.precio) > 0) || !(Number(m.cantidad) >= 1 && Number(m.cantidad) <= 99)) && 'Revise los materiales agregados',
  })
  await transaction(async (cx) => {
    const a = await asignacionPropia(req, cx)
    if (a.estado_asignacion !== 'Aceptada' || a.estado_solicitud !== 'En proceso') throw conflict('Solo puede completar una solicitud aceptada y en proceso')
    if (!(await estadoCobro(a.id_solicitud, cx)).anticipo_listo) throw conflict('El cliente aún no ha pagado el anticipo del 50 %. Puedes cobrarlo en efectivo con “Reportar cobro en efectivo”.')
    for (const m of materiales) {
      const cant = Number(m.cantidad)
      await exec('INSERT INTO solicitud_detalle (id_solicitud, id_servicio, descripcion, cantidad, precio_unitario, subtotal, aplica_itbis) VALUES (?, NULL, ?, ?, ?, ?, 1)',
        [a.id_solicitud, `Materiales: ${String(m.descripcion).trim()}`.slice(0, 150), cant, Number(m.precio), Number(m.precio) * cant], cx)
    }
    await exec(`UPDATE asignaciones_servicio SET estado_asignacion = 'Completada', fecha_completado = ${AHORA} WHERE id_asignacion = ?`, [a.id_asignacion], cx)
    await notificar(a.id_usuario_cliente, { tipo: 'Solicitud', titulo: `Servicio ${a.codigo_seguimiento} completado`, mensaje: 'Confirma la finalización y califica el servicio. Si no confirmas en 48 horas se confirmará automáticamente.', canales: ['App', 'WhatsApp'] }, cx)
  })
  res.json({ ok: true })
})

/**
 * Cargo adicional (nota de débito): solo después de completado y pagado el servicio, dentro de 30 días,
 * y sin otro cargo pendiente de respuesta o de pago. Devuelve el motivo si no procede.
 */
function puedeSolicitarCargo(a, cobro) {
  if (a.estado_asignacion !== 'Completada' || a.estado !== 'Completado') return 'El servicio debe estar completado y confirmado por el cliente'
  if (!cobro.pagado) return 'El servicio aún no está pagado. Los ajustes antes del pago se agregan como materiales al completar.'
  if (a.fecha_finalizacion && Date.now() - new Date(a.fecha_finalizacion).getTime() > DIAS_CARGO_ADICIONAL * 864e5) return `Han pasado más de ${DIAS_CARGO_ADICIONAL} días desde la finalización`
  if (cobro.cargos.some((c) => c.estado === 'Pendiente' || (c.estado === 'Aceptado' && c.pago?.estado !== 'Confirmado'))) return 'Hay un cargo adicional pendiente de respuesta o de pago'
  return null
}

// Solicitar un cargo adicional al cliente (trabajo extra o material no previsto)
rPrestador.post('/asignaciones/:id/cargos', async (req, res) => {
  const b = req.body
  const descripcion = String(b.descripcion || '').trim()
  const cantidad = Number(b.cantidad || 1), precio = Number(String(b.precio || '').replace(/,/g, ''))
  validar({
    descripcion: !(descripcion.length >= 3 && descripcion.length <= 120) && 'Describa el cargo (3 a 120 caracteres)',
    motivo: !String(b.motivo || '').trim() && 'Explique al cliente por qué se cobra',
    cantidad: !(Number.isInteger(cantidad) && cantidad >= 1 && cantidad <= 99) && 'Cantidad entre 1 y 99',
    precio: !(precio > 0 && precio <= 500000) && 'Indique el precio unitario',
  })
  const out = await transaction(async (cx) => {
    const a = await asignacionPropia(req, cx)
    const s = await one('SELECT estado, fecha_finalizacion FROM solicitudes_servicio WHERE id_solicitud = ?', [a.id_solicitud], cx)
    const motivoNo = puedeSolicitarCargo({ ...a, estado: s.estado, fecha_finalizacion: s.fecha_finalizacion }, await estadoCobro(a.id_solicitud, cx))
    if (motivoNo) throw conflict(motivoNo)
    const c = await exec(
      `INSERT INTO cargos_adicionales (id_solicitud, id_empleado, descripcion, motivo, cantidad, precio_unitario, aplica_itbis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [a.id_solicitud, a.id_empleado, descripcion, String(b.motivo).trim().slice(0, 300), cantidad, precio, b.aplica_itbis === false ? 0 : 1], cx)
    await notificar(a.id_usuario_cliente, {
      tipo: 'Solicitud', titulo: `Cargo adicional por aprobar · ${a.codigo_seguimiento}`,
      mensaje: `${req.usuario.nombre} ${req.usuario.apellido} solicita RD$ ${(precio * cantidad).toFixed(2)} + ITBIS por "${descripcion}". Acéptalo o recházalo desde el seguimiento de la solicitud.`,
      canales: ['App', 'Correo', 'WhatsApp'],
    }, cx)
    await auditar(req, 'Cargo adicional solicitado', 'cargos_adicionales', c.insertId, null, { descripcion, cantidad, precio }, cx)
    return { id_cargo: c.insertId, estado: 'Pendiente' }
  })
  res.status(201).json(out)
})

// El prestador puede retirar un cargo que el cliente aún no ha respondido
rPrestador.post('/cargos/:id/anular', async (req, res) => {
  const c = await one('SELECT * FROM cargos_adicionales WHERE id_cargo = ?', [req.params.id])
  if (!c) throw notFound('Cargo no encontrado')
  if (c.id_empleado !== req.usuario.id_empleado) throw forbidden()
  if (c.estado !== 'Pendiente') throw conflict('Solo se retira un cargo que el cliente no ha respondido')
  await exec("UPDATE cargos_adicionales SET estado = 'Anulado' WHERE id_cargo = ?", [c.id_cargo])
  res.json({ estado: 'Anulado' })
})

rPrestador.patch('/disponibilidad', async (req, res) => {
  if (!['Disponible', 'Ocupado', 'No disponible'].includes(req.body.estado)) throw badRequest('Estado inválido')
  await exec('UPDATE empleados SET estado_disponibilidad = ? WHERE id_empleado = ?', [req.body.estado, req.usuario.id_empleado])
  res.json({ ok: true })
})

rPrestador.get('/calificaciones', async (req, res) => {
  const e = await one('SELECT calificacion_promedio, total_resenas FROM empleados WHERE id_empleado = ?', [req.usuario.id_empleado])
  const distribucion = await query(
    'SELECT calificacion_cliente AS estrellas, COUNT(*) n FROM asignaciones_servicio WHERE id_empleado = ? AND calificacion_cliente IS NOT NULL GROUP BY calificacion_cliente',
    [req.usuario.id_empleado])
  const resenas = await query(
    `SELECT TOP 30 a.calificacion_cliente AS estrellas, a.comentario_cliente AS texto, a.fecha_completado AS fecha, CONCAT(u.nombre, ' ', LEFT(u.apellido, 1), '.') AS autor
       FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
       JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
      WHERE a.id_empleado = ? AND a.calificacion_cliente IS NOT NULL ORDER BY a.fecha_completado DESC`,
    [req.usuario.id_empleado])
  res.json({ ...e, distribucion, resenas })
})

rPrestador.get('/perfil', async (req, res) => {
  const e = await one('SELECT * FROM empleados WHERE id_empleado = ?', [req.usuario.id_empleado])
  const servicios = await query('SELECT id_servicio FROM empleado_servicio WHERE id_empleado = ?', [e.id_empleado])
  res.json({ ...e, servicios: servicios.map((s) => s.id_servicio) })
})

rPrestador.put('/perfil', async (req, res) => {
  const b = req.body
  const tarifa = b.tarifa_hora === undefined ? undefined : Number(b.tarifa_hora)
  validar({ tarifa_hora: tarifa !== undefined && !(tarifa > 0 && tarifa <= 50000) && 'Tarifa fuera de rango' })
  await transaction(async (cx) => {
    await exec(
      `UPDATE empleados SET especialidad = COALESCE(?, especialidad), tarifa_hora = COALESCE(?, tarifa_hora), zona_cobertura = COALESCE(?, zona_cobertura),
              horario = COALESCE(?, horario), presentacion = COALESCE(?, presentacion) WHERE id_empleado = ?`,
      [b.especialidad || null, tarifa ?? null, b.zona_cobertura ? String(b.zona_cobertura).slice(0, 500) : null, b.horario || null,
        b.presentacion ? String(b.presentacion).slice(0, 500) : null, req.usuario.id_empleado], cx)
    if (Array.isArray(b.servicios)) {
      await exec('DELETE FROM empleado_servicio WHERE id_empleado = ?', [req.usuario.id_empleado], cx)
      for (const s of new Set(b.servicios.map(Number))) await exec('INSERT INTO empleado_servicio (id_empleado, id_servicio) VALUES (?, ?)', [req.usuario.id_empleado, s], cx)
    }
  })
  res.json({ ok: true })
})

// =====================================================================
// Administrador: todas las solicitudes y asignación manual
// =====================================================================
export const rAdminSolicitudes = Router()
rAdminSolicitudes.use(autenticar, soloRol('Administrador'))

rAdminSolicitudes.get('/', async (req, res) => {
  const { estado, q, sin_prestador } = req.query
  const where = [], p = []
  if (estado) { where.push('s.estado = ?'); p.push(estado) }
  if (q) { where.push("(s.codigo_seguimiento LIKE ? OR CONCAT(uc.nombre, ' ', uc.apellido) LIKE ?)"); p.push(`%${q}%`, `%${q}%`) }
  if (sin_prestador) where.push("s.estado = 'Pendiente' AND (a.id_asignacion IS NULL OR a.estado_asignacion = 'Rechazada')")
  const rows = await query(`${SQL_SOLICITUD.replace('SELECT', 'SELECT TOP 300')} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.fecha_solicitud DESC`, p)
  const out = []
  for (const s of rows) {
    const t = await totalesSolicitud(s.id_solicitud)
    const srv = await query('SELECT COALESCE(sv.nombre, d.descripcion) n FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = ? AND d.id_servicio IS NOT NULL', [s.id_solicitud])
    out.push({
      codigo: s.codigo_seguimiento, cliente: s.cliente, servicio: srv.map((x) => x.n).join(', '),
      prestador: s.estado_asignacion && s.estado_asignacion !== 'Rechazada' ? s.prestador : null,
      estado_asignacion: s.estado_asignacion, fecha: s.fecha_preferida, total: t.total, estado: s.estado,
    })
  }
  res.json(out)
})

rAdminSolicitudes.post('/:codigo/asignar', async (req, res) => {
  const s = await cargarSolicitud(req.params.codigo)
  if (s.estado !== 'Pendiente') throw conflict('Solo se asignan solicitudes Pendientes')
  await transaction(async (cx) => {
    const e = await one("SELECT id_empleado FROM empleados WHERE id_empleado = ? AND estado_aprobacion = 'Aprobado'", [req.body.id_empleado], cx)
    if (!e) throw badRequest('Prestador no válido')
    await exec("UPDATE asignaciones_servicio SET estado_asignacion = 'Rechazada' WHERE id_solicitud = ? AND estado_asignacion = 'Asignada'", [s.id_solicitud], cx)
    await asignarPrestador(cx, s.id_solicitud, e.id_empleado, 'Manual')
    await auditar(req, 'Asignación manual', 'solicitudes_servicio', s.id_solicitud, null, { id_empleado: e.id_empleado }, cx)
  })
  res.json({ ok: true })
})

/** Asignaciones sin respuesta en 2 h → Rechazada y reasignación automática. */
export async function vencerAsignaciones() {
  const vencidas = await query(
    `SELECT a.id_asignacion, a.id_solicitud FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
      WHERE a.estado_asignacion = 'Asignada' AND s.estado = 'Pendiente' AND a.fecha_asignacion < DATEADD(HOUR, -?, ${AHORA})`,
    [PLAZO_RESPUESTA_H])
  for (const v of vencidas) {
    await transaction(async (cx) => {
      await exec("UPDATE asignaciones_servicio SET estado_asignacion = 'Rechazada' WHERE id_asignacion = ? AND estado_asignacion = 'Asignada'", [v.id_asignacion], cx)
      await asignacionAutomatica(cx, v.id_solicitud)
    })
  }
  return vencidas.length
}

/** Si el cliente no confirma en 48 h, la solicitud se confirma automáticamente. */
export async function confirmarAutomaticamente() {
  const pendientes = await query(
    `SELECT s.id_solicitud, s.codigo_seguimiento, c.id_usuario FROM solicitudes_servicio s
       JOIN asignaciones_servicio a ON a.id_solicitud = s.id_solicitud AND a.estado_asignacion = 'Completada'
       JOIN clientes c ON c.id_cliente = s.id_cliente
      WHERE s.estado = 'En proceso' AND a.fecha_completado < DATEADD(HOUR, -48, ${AHORA})`)
  for (const s of pendientes) {
    await transaction(async (cx) => {
      const r = await exec(`UPDATE solicitudes_servicio SET estado = 'Completado', fecha_finalizacion = ${AHORA} WHERE id_solicitud = ? AND estado = 'En proceso'`, [s.id_solicitud], cx)
      if (r.affectedRows && (await estadoCobro(s.id_solicitud, cx)).cubierto_por_plan) await acreditarSinPago(cx, s.id_solicitud)
    })
    await notificar(s.id_usuario, { tipo: 'Solicitud', titulo: `Solicitud ${s.codigo_seguimiento} confirmada automáticamente`, mensaje: 'Pasaron 48 horas desde que el prestador la completó. Ya puedes pagar y calificar al prestador desde el seguimiento.', canales: ['App', 'Correo'] })
  }
  return pendientes.length
}

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.use('/solicitudes', rSolicitudes)
router.use('/prestador', rPrestador)
router.use('/admin/solicitudes', rAdminSolicitudes)
