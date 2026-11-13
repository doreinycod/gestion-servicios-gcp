// =====================================================================
// MOD-CAT · Catálogo y Prestadores (proceso 1.0)
// CAT-P01 Catálogo · CAT-P02 Perfil del prestador · CAT-P04 Mantenimiento de servicios · CAT-P05 Planes y suscripciones (CAT-P03 Registro de prestador está en mod-adm, ruta /auth/registro-prestador)
// =====================================================================
import { Router } from 'express'
import { exec, one, query, transaction } from '../config/db.js'
import { autenticar, autenticarOpcional, soloRol } from '../middleware/auth.js'
import { badRequest, conflict, notFound, validar } from '../lib/http.js'
import { auditar } from './mod-adm.js'
import { crearOrden, paypalSimulado } from './mod-pag.js'
import { round2, calcularTotales } from '../lib/fiscal.js'

const rCatalogo = Router()
const esAdmin = (req) => req.usuario?.nombre_rol === 'Administrador'
const codigoSrv = (id) => `SRV-${String(id).padStart(3, '0')}`

// ---------- Categorías ----------
rCatalogo.get('/categorias', async (_req, res) => {
  res.json(await query(
    `SELECT c.*, (SELECT COUNT(*) FROM servicios s WHERE s.id_categoria = c.id_categoria AND s.estado = 'Publicado') AS total
       FROM categorias_servicio c WHERE c.estado = 'Activa' ORDER BY c.id_categoria`,
  ))
})

// ---------- CAT-P01 · Servicios (públicos: solo Publicado; admin: todos) ----------
rCatalogo.get('/servicios', autenticarOpcional, async (req, res) => {
  const { categoria, q, min, max, modalidad, estado } = req.query
  const where = [], p = []
  if (!esAdmin(req)) where.push("s.estado = 'Publicado'")
  else if (estado) { where.push('s.estado = ?'); p.push(estado) }
  if (categoria) { where.push('(c.nombre = ? OR c.id_categoria = ?)'); p.push(categoria, Number(categoria) || 0) }
  if (q) { where.push('(s.nombre LIKE ? OR s.descripcion LIKE ?)'); p.push(`%${q}%`, `%${q}%`) }
  if (min) { where.push('s.precio_base >= ?'); p.push(Number(min)) }
  if (max) { where.push('s.precio_base <= ?'); p.push(Number(max)) }
  if (modalidad === 'En sitio') where.push("s.modalidad IN ('En sitio','Ambas')")
  if (modalidad === 'Remoto') where.push("s.modalidad IN ('Remoto','Ambas')")
  const rows = await query(
    `SELECT s.*, c.nombre AS categoria, x.prestadores, x.calificacion,
            (SELECT COUNT(*) FROM solicitud_detalle d WHERE d.id_servicio = s.id_servicio) AS solicitudes
       FROM servicios s JOIN categorias_servicio c ON c.id_categoria = s.id_categoria
       OUTER APPLY (SELECT COUNT(*) AS prestadores, CAST(ROUND(AVG(CAST(e.calificacion_promedio AS DECIMAL(4,2))), 1) AS DECIMAL(3,1)) AS calificacion
                      FROM empleado_servicio es JOIN empleados e ON e.id_empleado = es.id_empleado
                     WHERE es.id_servicio = s.id_servicio AND e.estado_aprobacion = 'Aprobado') x
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY solicitudes DESC, s.id_servicio`,
    p,
  )
  res.json(rows.map((s) => ({ ...s, codigo: codigoSrv(s.id_servicio), aplica_itbis: !!s.aplica_itbis })))
})

rCatalogo.get('/servicios/:id', autenticarOpcional, async (req, res) => {
  const s = await one(
    `SELECT s.*, c.nombre AS categoria FROM servicios s JOIN categorias_servicio c ON c.id_categoria = s.id_categoria WHERE s.id_servicio = ?`,
    [req.params.id],
  )
  if (!s || (s.estado !== 'Publicado' && !esAdmin(req))) throw notFound('Servicio no encontrado')
  res.json({ ...s, codigo: codigoSrv(s.id_servicio), aplica_itbis: !!s.aplica_itbis })
})

// ---------- CAT-P04 · Mantenimiento de servicios (administrador) ----------
async function validarServicio(b, id = null) {
  const precio = Number(String(b.precio_base ?? '').replace(/,/g, ''))
  const dur = b.duracion_estimada === undefined || b.duracion_estimada === '' ? null : Number(b.duracion_estimada)
  validar({
    id_categoria: !Number(b.id_categoria) && 'Seleccione la categoría',
    nombre: !(String(b.nombre || '').trim().length >= 3 && b.nombre.length <= 100) && 'Complete los campos obligatorios',
    precio_base: !(precio > 0) && 'El precio debe ser mayor que cero',
    duracion_estimada: dur !== null && !(dur >= 15 && dur <= 1440) && 'Duración fuera de rango',
    modalidad: !['En sitio', 'Remoto', 'Ambas'].includes(b.modalidad) && 'Seleccione la modalidad',
  })
  const dup = await one('SELECT id_servicio FROM servicios WHERE id_categoria = ? AND nombre = ? AND id_servicio <> ?', [b.id_categoria, b.nombre.trim(), id || 0])
  if (dup) throw conflict('Ya existe un servicio con ese nombre')
  return { precio, dur }
}

rCatalogo.post('/servicios', autenticar, soloRol('Administrador'), async (req, res) => {
  const b = req.body
  const { precio, dur } = await validarServicio(b)
  const estado = b.estado === 'Publicado' ? 'Publicado' : 'Borrador'
  const x = await exec(
    'INSERT INTO servicios (id_categoria, nombre, descripcion, precio_base, duracion_estimada, modalidad, aplica_itbis, estado, icono) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [b.id_categoria, b.nombre.trim(), b.descripcion || null, precio, dur, b.modalidad, b.aplica_itbis !== false, estado, b.icono || null],
  )
  await auditar(req, `Servicio creado (${estado})`, 'servicios', x.insertId, null, b)
  res.status(201).json({ id_servicio: x.insertId, codigo: codigoSrv(x.insertId), estado })
})

rCatalogo.put('/servicios/:id', autenticar, soloRol('Administrador'), async (req, res) => {
  const anterior = await one('SELECT * FROM servicios WHERE id_servicio = ?', [req.params.id])
  if (!anterior) throw notFound('Servicio no encontrado')
  const b = { ...anterior, ...req.body }
  const { precio, dur } = await validarServicio(b, anterior.id_servicio)
  const estado = ['Publicado', 'Borrador', 'Inactivo'].includes(b.estado) ? b.estado : anterior.estado
  await exec(
    'UPDATE servicios SET id_categoria = ?, nombre = ?, descripcion = ?, precio_base = ?, duracion_estimada = ?, modalidad = ?, aplica_itbis = ?, estado = ?, icono = ? WHERE id_servicio = ?',
    [b.id_categoria, b.nombre.trim(), b.descripcion || null, precio, dur, b.modalidad, !!b.aplica_itbis, estado, b.icono || null, anterior.id_servicio],
  )
  await auditar(req, 'Servicio actualizado', 'servicios', anterior.id_servicio, anterior, req.body)
  res.json({ ok: true })
})

// Retirar un servicio: no se elimina, pasa a Inactivo (conserva historial)
rCatalogo.patch('/servicios/:id/estado', autenticar, soloRol('Administrador'), async (req, res) => {
  if (!['Publicado', 'Borrador', 'Inactivo'].includes(req.body.estado)) throw badRequest('Estado inválido')
  const x = await exec('UPDATE servicios SET estado = ? WHERE id_servicio = ?', [req.body.estado, req.params.id])
  if (!x.affectedRows) throw notFound('Servicio no encontrado')
  await auditar(req, `Servicio ${req.body.estado}`, 'servicios', Number(req.params.id))
  res.json({ ok: true })
})

// Prestador con membresía vigente que lo destaca en el catálogo (1/0), sobre el alias e
const SQL_DESTACADO = `IIF(EXISTS (SELECT 1 FROM clientes cm JOIN suscripciones sm ON sm.id_cliente = cm.id_cliente JOIN planes pm ON pm.id_plan = sm.id_plan
   WHERE cm.id_usuario = e.id_usuario AND pm.dirigido_a = 'Prestador' AND pm.destacado = 1
     AND sm.estado IN ('Activa','Cancelada') AND sm.fecha_renovacion >= CAST(GETDATE() AS date)), 1, 0)`

// ---------- CAT-P01 / CAT-P02 · Prestadores aprobados ----------
rCatalogo.get('/prestadores', async (req, res) => {
  const { servicio, categoria, calificacion, zona, limite } = req.query
  const where = ["e.estado_aprobacion = 'Aprobado'", "u.estado = 'Activo'"], p = []
  if (servicio) { where.push('EXISTS (SELECT 1 FROM empleado_servicio es WHERE es.id_empleado = e.id_empleado AND es.id_servicio = ?)'); p.push(Number(servicio)) }
  if (categoria) { where.push('(c.nombre = ? OR c.id_categoria = ?)'); p.push(categoria, Number(categoria) || 0) }
  if (calificacion) { where.push('e.calificacion_promedio >= ?'); p.push(Number(calificacion)) }
  if (zona) { where.push('e.zona_cobertura LIKE ?'); p.push(`%${zona}%`) }
  res.json(await query(
    `SELECT TOP (?) e.id_empleado, u.nombre, u.apellido, e.especialidad, e.tarifa_hora, e.zona_cobertura, e.calificacion_promedio,
            e.total_resenas, e.estado_disponibilidad, e.anios_experiencia, c.nombre AS categoria, ${SQL_DESTACADO} AS destacado
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario JOIN categorias_servicio c ON c.id_categoria = e.id_categoria
      WHERE ${where.join(' AND ')}
      ORDER BY destacado DESC, e.calificacion_promedio DESC, e.total_resenas DESC`,
    [Math.min(Number(limite) || 50, 100), ...p],
  ))
})

rCatalogo.get('/prestadores/:id', async (req, res) => {
  const e = await one(
    `SELECT e.id_empleado, u.nombre, u.apellido, u.telefono, e.especialidad, e.tarifa_hora, e.zona_cobertura, e.calificacion_promedio,
            e.total_resenas, e.estado_disponibilidad, e.anios_experiencia, e.horario, e.presentacion, c.nombre AS categoria
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario JOIN categorias_servicio c ON c.id_categoria = e.id_categoria
      WHERE e.id_empleado = ? AND e.estado_aprobacion = 'Aprobado'`,
    [req.params.id],
  )
  if (!e) throw notFound('Prestador no encontrado')
  const servicios = await query(
    `SELECT s.id_servicio, s.nombre, s.modalidad, s.duracion_estimada, s.precio_base FROM empleado_servicio es
       JOIN servicios s ON s.id_servicio = es.id_servicio WHERE es.id_empleado = ? AND s.estado = 'Publicado'`,
    [e.id_empleado],
  )
  const resenas = await query(
    `SELECT TOP 5 a.calificacion_cliente AS estrellas, a.comentario_cliente AS texto, a.fecha_completado AS fecha,
            CONCAT(u.nombre, ' ', LEFT(u.apellido, 1), '.') AS autor
       FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
       JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
      WHERE a.id_empleado = ? AND a.calificacion_cliente IS NOT NULL ORDER BY a.fecha_completado DESC`,
    [e.id_empleado],
  )
  // Disponibilidad: citas ocupadas de los próximos 45 días
  const ocupado = await query(
    `SELECT s.fecha_preferida AS fecha, s.hora_preferida AS hora FROM asignaciones_servicio a
       JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
      WHERE a.id_empleado = ? AND a.estado_asignacion IN ('Asignada','Aceptada')
        AND s.fecha_preferida BETWEEN CAST(GETDATE() AS date) AND DATEADD(DAY, 45, CAST(GETDATE() AS date))`,
    [e.id_empleado],
  )
  res.json({ ...e, servicios, resenas, ocupado })
})

// ---------- CAT-P05 · Planes de suscripción ----------
// ?para=Cliente (por defecto) | Prestador | Todos (administración, incluye inactivos)
rCatalogo.get('/planes', autenticarOpcional, async (req, res) => {
  const para = ['Prestador', 'Todos'].includes(req.query.para) ? req.query.para : 'Cliente'
  const planes = para === 'Todos' && esAdmin(req)
    ? await query('SELECT * FROM planes ORDER BY dirigido_a, precio_mensual')
    : await query("SELECT * FROM planes WHERE estado = 'Activo' AND dirigido_a = ? ORDER BY precio_mensual", [para === 'Todos' ? 'Cliente' : para])
  const items = await query(
    'SELECT ps.*, s.nombre FROM plan_servicio ps JOIN servicios s ON s.id_servicio = ps.id_servicio',
  )
  res.json(planes.map((p) => ({ ...p, servicios: items.filter((i) => i.id_plan === p.id_plan) })))
})

/** Beneficios de la membresía del prestador: comisión reducida (0-100 %, vacío = la general), prioridad y destacado. */
function beneficiosPrestador(b) {
  const pct = b.comision_pct === '' || b.comision_pct == null ? null : Number(b.comision_pct)
  validar({ comision_pct: pct !== null && !(pct >= 0 && pct <= 100) && 'La comisión debe estar entre 0 y 100 %' })
  return { comision_pct: pct, prioridad_asignacion: b.prioridad_asignacion ? 1 : 0, destacado: b.destacado ? 1 : 0 }
}

rCatalogo.post('/planes', autenticar, soloRol('Administrador'), async (req, res) => {
  const b = req.body
  const dirigido = b.dirigido_a === 'Prestador' ? 'Prestador' : 'Cliente'
  validar({
    nombre: !String(b.nombre || '').trim() && 'Indique el nombre', precio_mensual: !(Number(b.precio_mensual) > 0) && 'El precio debe ser mayor que cero',
    periodicidad: b.periodicidad && !['Mensual', 'Trimestral', 'Anual'].includes(b.periodicidad) && 'Periodicidad inválida',
  })
  const ben = dirigido === 'Prestador' ? beneficiosPrestador(b) : { comision_pct: null, prioridad_asignacion: 0, destacado: 0 }
  const id = await transaction(async (cx) => {
    const x = await exec(
      `INSERT INTO planes (nombre, descripcion, precio_mensual, periodicidad, paypal_plan_id, dirigido_a, comision_pct, prioridad_asignacion, destacado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.nombre.trim(), b.descripcion || null, Number(b.precio_mensual), b.periodicidad || 'Mensual', b.paypal_plan_id || null,
        dirigido, ben.comision_pct, ben.prioridad_asignacion, ben.destacado], cx)
    // Los servicios incluidos solo aplican a planes de clientes
    for (const s of dirigido === 'Cliente' ? b.servicios || [] : []) {
      await exec('INSERT INTO plan_servicio (id_plan, id_servicio, cantidad_incluida, descuento_pct) VALUES (?, ?, ?, ?)',
        [x.insertId, s.id_servicio, Number(s.cantidad_incluida) || 0, Number(s.descuento_pct) || 0], cx)
    }
    return x.insertId
  })
  await auditar(req, 'Plan creado', 'planes', id, null, b)
  res.status(201).json({ id_plan: id })
})

rCatalogo.put('/planes/:id', autenticar, soloRol('Administrador'), async (req, res) => {
  const b = req.body
  const plan = await one('SELECT dirigido_a FROM planes WHERE id_plan = ?', [req.params.id])
  if (!plan) throw notFound('Plan no encontrado')
  await transaction(async (cx) => {
    await exec('UPDATE planes SET nombre = COALESCE(?, nombre), descripcion = COALESCE(?, descripcion), precio_mensual = COALESCE(?, precio_mensual), estado = COALESCE(?, estado) WHERE id_plan = ?',
      [b.nombre || null, b.descripcion || null, b.precio_mensual || null, b.estado || null, req.params.id], cx)
    if (plan.dirigido_a === 'Prestador' && ['comision_pct', 'prioridad_asignacion', 'destacado'].some((k) => k in b)) {
      const ben = beneficiosPrestador(b)
      await exec('UPDATE planes SET comision_pct = ?, prioridad_asignacion = ?, destacado = ? WHERE id_plan = ?',
        [ben.comision_pct, ben.prioridad_asignacion, ben.destacado, req.params.id], cx)
    }
    if (plan.dirigido_a === 'Cliente' && Array.isArray(b.servicios)) {
      await exec('DELETE FROM plan_servicio WHERE id_plan = ?', [req.params.id], cx)
      for (const s of b.servicios) {
        await exec('INSERT INTO plan_servicio (id_plan, id_servicio, cantidad_incluida, descuento_pct) VALUES (?, ?, ?, ?)',
          [req.params.id, s.id_servicio, Number(s.cantidad_incluida) || 0, Number(s.descuento_pct) || 0], cx)
      }
    }
  })
  await auditar(req, 'Plan actualizado', 'planes', Number(req.params.id), null, b)
  res.json({ ok: true })
})

// =====================================================================
// CAT-P05 · Suscripción a planes (cobro recurrente vía PayPal Subscriptions)
// =====================================================================
const rSuscripciones = Router()
rSuscripciones.use(autenticar)

const PARA_ROL = { Cliente: 'Cliente', Empleado: 'Prestador' }

/**
 * Perfil de facturación del prestador (fila en clientes): con él paga su membresía con los mismos
 * métodos y recibe su factura e-CF. Usa su cédula si no la tiene otro cliente; si no, consumidor final.
 */
async function perfilFacturacion(req, cx) {
  if (req.usuario.id_cliente) return req.usuario.id_cliente
  const e = await one('SELECT cedula, zona_cobertura FROM empleados WHERE id_empleado = ?', [req.usuario.id_empleado], cx)
  const doc = String(e?.cedula || '').replace(/\D/g, '')
  const libre = doc.length === 11 && !(await one('SELECT 1 AS x FROM clientes WHERE rnc_cedula = ?', [doc], cx))
  const zona = String(e?.zona_cobertura || '').split(',')[0].trim()
  const c = await exec("INSERT INTO clientes (id_usuario, tipo_cliente, rnc_cedula, razon_social, direccion, ciudad) VALUES (?, 'Persona física', ?, NULL, ?, ?)",
    [req.usuario.id_usuario, libre ? doc : null, (zona || 'No indicada').slice(0, 200), 'Santiago'], cx)
  req.usuario.id_cliente = c.insertId
  return c.insertId
}

rSuscripciones.get('/mias', soloRol('Cliente', 'Empleado'), async (req, res) => {
  if (!req.usuario.id_cliente) return res.json([])
  const subs = await query(
    `SELECT s.*, p.nombre AS [plan], p.precio_mensual, p.periodicidad, x.metodo, x.referencia, x.id_pago, x.estado_pago
       FROM suscripciones s JOIN planes p ON p.id_plan = s.id_plan
       OUTER APPLY (SELECT TOP 1 metodo_pago AS metodo, referencia, id_pago, estado AS estado_pago FROM pagos
                     WHERE id_suscripcion = s.id_suscripcion ORDER BY id_pago DESC) x
      WHERE s.id_cliente = ? AND s.estado <> 'Pendiente' AND p.dirigido_a = ? ORDER BY s.id_suscripcion DESC`,
    [req.usuario.id_cliente, PARA_ROL[req.usuario.nombre_rol]])
  // Uso del periodo vigente: servicios del plan solicitados desde el inicio del periodo
  for (const s of subs.filter((x) => ['Activa', 'Cancelada'].includes(x.estado) && x.fecha_renovacion >= new Date().toISOString().slice(0, 10))) {
    s.vigente = true
    s.uso = await query(
      `SELECT sv.nombre, ps.cantidad_incluida, ps.descuento_pct,
              (SELECT COALESCE(SUM(d.cantidad), 0) FROM solicitud_detalle d JOIN solicitudes_servicio so ON so.id_solicitud = d.id_solicitud
                WHERE so.id_cliente = ? AND d.id_servicio = ps.id_servicio AND so.estado <> 'Cancelado' AND so.fecha_solicitud >= ?) AS usados
         FROM plan_servicio ps JOIN servicios sv ON sv.id_servicio = ps.id_servicio WHERE ps.id_plan = ?`,
      [req.usuario.id_cliente, s.fecha_inicio, s.id_plan])
  }
  res.json(subs)
})

/**
 * Suscribirse: crea la suscripción Pendiente y su pago del periodo (precio × meses + ITBIS).
 *  - PayPal: crea la orden y devuelve aprobar_url; el cliente paga en PayPal y al volver se captura.
 *  - Tarjeta: el frontend completa el pago con POST /pagos/:id/tarjeta.
 * Al confirmarse el pago (confirmarPago) la suscripción pasa a Activa y se emite su factura e-CF.
 */
rSuscripciones.post('/', soloRol('Cliente', 'Empleado'), async (req, res) => {
  const metodo = req.body.metodo_pago
  validar({ metodo_pago: !['PayPal', 'Tarjeta'].includes(metodo) && 'Seleccione PayPal o tarjeta' })
  const out = await transaction(async (cx) => {
    const plan = await one("SELECT * FROM planes WHERE id_plan = ? AND estado = 'Activo' AND dirigido_a = ?", [req.body.id_plan, PARA_ROL[req.usuario.nombre_rol]], cx)
    if (!plan) throw notFound('Plan no disponible')
    if (req.usuario.nombre_rol === 'Empleado') await perfilFacturacion(req, cx)
    // Cambio de plan: se permite elegir otro; al pagarse, el plan anterior termina (confirmarPago). Solo se impide repetir el plan activo.
    const activa = await one("SELECT TOP 1 s.id_plan FROM suscripciones s WHERE s.id_cliente = ? AND s.estado = 'Activa' AND s.id_plan = ?",
      [req.usuario.id_cliente, plan.id_plan], cx)
    if (activa) throw conflict(`El plan ${plan.nombre} ya es tu plan activo.`)
    // Un intento anterior sin pagar se descarta
    const previas = await query("SELECT id_suscripcion FROM suscripciones WHERE id_cliente = ? AND estado = 'Pendiente'", [req.usuario.id_cliente], cx)
    for (const x of previas) {
      await exec("UPDATE pagos SET estado = 'Rechazado', observacion = 'Reemplazado por un nuevo intento' WHERE id_suscripcion = ? AND estado = 'Pendiente'", [x.id_suscripcion], cx)
      await exec("UPDATE suscripciones SET estado = 'Cancelada' WHERE id_suscripcion = ?", [x.id_suscripcion], cx)
    }
    const meses = { Mensual: 1, Trimestral: 3, Anual: 12 }[plan.periodicidad] || 1
    const s = await exec(
      `INSERT INTO suscripciones (id_cliente, id_plan, fecha_inicio, fecha_renovacion, estado)
       VALUES (?, ?, CAST(GETDATE() AS date), DATEADD(MONTH, ?, CAST(GETDATE() AS date)), 'Pendiente')`,
      [req.usuario.id_cliente, plan.id_plan, meses], cx)
    // Mismo cálculo que la factura del plan (precio × meses + ITBIS 18 %)
    const t = calcularTotales([{ cantidad: meses, precio_unitario: Number(plan.precio_mensual), subtotal: Number(plan.precio_mensual) * meses, aplica_itbis: true }])
    const p = await exec("INSERT INTO pagos (id_cliente, id_suscripcion, monto, metodo_pago, estado) VALUES (?, ?, ?, ?, 'Pendiente')",
      [req.usuario.id_cliente, s.insertId, t.total, metodo], cx)
    const r = { id_suscripcion: s.insertId, id_pago: p.insertId, monto: t.total, plan: plan.nombre, metodo_pago: metodo }
    if (metodo === 'PayPal') {
      const tasa = Number(process.env.TASA_USD || 61)
      const usd = round2(t.total / tasa)
      const front = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
      const orden = await crearOrden({
        montoUsd: usd, referencia: `PLAN-${s.insertId}`, descripcion: `Plan ${plan.nombre} (${plan.periodicidad.toLowerCase()}) · Directorio Servicios`,
        returnUrl: `${front}${req.usuario.nombre_rol === 'Empleado' ? '/prestador' : '/pagos'}/paypal/retorno?pago=${p.insertId}`,
        cancelUrl: `${front}${req.usuario.nombre_rol === 'Empleado' ? '/prestador/membresia' : '/planes'}?cancelado=1`,
      })
      await exec("INSERT INTO paypal_transacciones (id_pago, paypal_order_id, monto_usd, tasa_cambio, estado_paypal) VALUES (?, ?, ?, ?, 'CREATED')",
        [p.insertId, orden.id, usd, tasa], cx)
      Object.assign(r, { aprobar_url: orden.aprobarUrl, monto_usd: usd, simulado: paypalSimulado() })
    }
    return r
  })
  res.status(201).json(out)
})

// Cancelación efectiva al final del periodo pagado (el plan sigue aplicando hasta fecha_renovacion)
rSuscripciones.post('/:id/cancelar', soloRol('Cliente', 'Empleado'), async (req, res) => {
  const x = await exec("UPDATE suscripciones SET estado = 'Cancelada' WHERE id_suscripcion = ? AND id_cliente = ? AND estado = 'Activa'", [req.params.id, req.usuario.id_cliente])
  if (!x.affectedRows) throw notFound('Suscripción activa no encontrada')
  res.json({ estado: 'Cancelada' })
})

const rAdminSuscripciones = Router()
rAdminSuscripciones.use(autenticar, soloRol('Administrador'))

// ---------- Planes y suscripciones ----------
rAdminSuscripciones.get('/', async (_req, res) => {
  res.json(await query(
    `SELECT s.*, p.nombre AS [plan], p.dirigido_a, COALESCE(c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente
       FROM suscripciones s JOIN planes p ON p.id_plan = s.id_plan JOIN clientes c ON c.id_cliente = s.id_cliente
       JOIN usuarios u ON u.id_usuario = c.id_usuario ORDER BY s.id_suscripcion DESC`))
})

/** Suscripciones canceladas cuyo periodo terminó → Vencida. */
export async function vencerSuscripciones() {
  const r = await exec("UPDATE suscripciones SET estado = 'Vencida' WHERE estado IN ('Activa','Cancelada') AND fecha_renovacion < CAST(GETDATE() AS date) AND (estado = 'Cancelada' OR paypal_subscription_id IS NULL)")
  // Suscripciones que nunca se pagaron (el cliente abandonó PayPal) → se descartan al día siguiente
  await exec(`UPDATE p SET estado = 'Rechazado', observacion = 'Suscripción no pagada' FROM pagos p JOIN suscripciones s ON s.id_suscripcion = p.id_suscripcion
               WHERE s.estado = 'Pendiente' AND p.estado = 'Pendiente' AND s.fecha_inicio < CAST(GETDATE() AS date)`)
  await exec("UPDATE suscripciones SET estado = 'Cancelada' WHERE estado = 'Pendiente' AND fecha_inicio < CAST(GETDATE() AS date)")
  return r.affectedRows
}

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
router.use('/catalogo', rCatalogo)
router.use('/suscripciones', rSuscripciones)
router.use('/admin/suscripciones', rAdminSuscripciones)
