// =====================================================================
// Consultas y reportes por rol (ADM-P05 · sección 31).
// Cada definición indica: rol, tipo (consulta | reporte), filtros, columnas, cómo obtener las filas,
// el resumen (totales) y la gráfica. El motor (ejecutarReporte) aplica el periodo, la búsqueda y el
// estado, y limita los datos al usuario: el cliente solo ve lo suyo y el prestador solo lo suyo.
// =====================================================================
import { query } from '../config/db.js'
import { round2 } from './fiscal.js'

const ENTRE = (col) => `CAST(${col} AS date) BETWEEN ? AND ?`
const PAG = (id) => `PAG-${String(id).padStart(4, '0')}`
const CONCEPTO = { Total: 'Pago único', Anticipo: 'Anticipo 50 %', Saldo: 'Saldo 50 %', Cargo: 'Cargo adicional' }
// Documentos fiscales con signo: las notas de crédito restan (una factura anulada + su NC suman 0)
const SIGNO = "IIF(f.tipo_documento = 'Nota de crédito', -1, 1)"
const DOC_ACEPTADO = "EXISTS (SELECT 1 FROM ecf ea WHERE ea.id_factura = f.id_factura AND ea.estado_dgii LIKE 'Aceptado%')"
const sum = (filas, k) => round2(filas.reduce((s, f) => s + Number(f[k] || 0), 0))
const normal = (t = '') => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const SECTORES_SANTIAGO = ['Centro de la Ciudad', 'Los Jardines Metropolitanos', 'Cerros de Gurabo', 'Villa Olga', 'La Trinitaria', 'Reparto del Este',
  'Gurabo', 'Pueblo Nuevo', 'Los Pepines', 'Cienfuegos', 'Pekín', 'Bella Terra', 'Ensanche Bermúdez', 'Los Salados', 'Rincón Largo', 'Villa María', 'Baracoa', 'Hoya del Caimito']

/** Filtro de texto sobre varias columnas: (a LIKE ? OR b LIKE ? ...) */
function buscar(ctx, columnas, where, p) {
  if (!ctx.q) return
  where.push(`(${columnas.map((c) => `${c} LIKE ?`).join(' OR ')})`)
  for (let i = 0; i < columnas.length; i++) p.push(`%${ctx.q}%`)
}
function porEstado(ctx, col, where, p) {
  if (!ctx.estado) return
  where.push(`${col} = ?`)
  p.push(ctx.estado)
}

// Columnas: { k: campo, t: título, f: formato (texto | fecha | fechahora | dinero | numero | pct | estado | estrellas) }
export const REPORTES = [
  // ================================ CLIENTE ================================
  {
    id: 'cli-solicitudes', rol: 'Cliente', tipo: 'consulta', titulo: 'Mis solicitudes', icono: '📋',
    descripcion: 'Todas tus solicitudes con su prestador, cita, estado y lo pagado.',
    filtros: { periodo: 'Fecha de la solicitud', busqueda: 'Código o servicio', estados: ['Pendiente', 'En proceso', 'Completado', 'Cancelado'] },
    columnas: [
      { k: 'codigo', t: 'Código' }, { k: 'fecha', t: 'Solicitada', f: 'fecha' }, { k: 'servicio', t: 'Servicio' },
      { k: 'prestador', t: 'Prestador' }, { k: 'cita', t: 'Cita', f: 'fecha' }, { k: 'estado', t: 'Estado', f: 'estado' }, { k: 'pagado', t: 'Pagado', f: 'dinero' },
    ],
    enlace: (f) => `/seguimiento/${f.codigo}`,
    async datos(ctx) {
      const where = ['s.id_cliente = ?', ENTRE('s.fecha_solicitud')], p = [ctx.usuario.id_cliente, ctx.desde, ctx.hasta]
      buscar(ctx, ['s.codigo_seguimiento', 'srv.servicio'], where, p)
      porEstado(ctx, 's.estado', where, p)
      return query(
        `SELECT TOP 1000 s.codigo_seguimiento AS codigo, s.fecha_solicitud AS fecha, srv.servicio, pr.prestador, s.fecha_preferida AS cita, s.estado,
                (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE id_solicitud = s.id_solicitud AND estado = 'Confirmado') AS pagado
           FROM solicitudes_servicio s
           OUTER APPLY (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') AS servicio FROM solicitud_detalle d
                          LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) srv
           OUTER APPLY (SELECT TOP 1 CONCAT(u.nombre, ' ', u.apellido) AS prestador FROM asignaciones_servicio a JOIN empleados e ON e.id_empleado = a.id_empleado
                          JOIN usuarios u ON u.id_usuario = e.id_usuario WHERE a.id_solicitud = s.id_solicitud AND a.estado_asignacion <> 'Rechazada'
                         ORDER BY a.id_asignacion DESC) pr
          WHERE ${where.join(' AND ')} ORDER BY s.fecha_solicitud DESC`, p)
    },
    resumen: (f) => [{ t: 'Solicitudes', v: f.length }, { t: 'Activas', v: f.filter((x) => ['Pendiente', 'En proceso'].includes(x.estado)).length }, { t: 'Total pagado', v: sum(f, 'pagado'), f: 'dinero' }],
  },
  {
    id: 'cli-pagos', rol: 'Cliente', tipo: 'consulta', titulo: 'Mis pagos', icono: '💳',
    descripcion: 'Cada pago con su método, referencia, concepto y estado.',
    filtros: { periodo: 'Fecha del pago', busqueda: 'Referencia o solicitud', estados: ['Confirmado', 'En verificación', 'Pendiente', 'Rechazado', 'Reembolsado'] },
    columnas: [
      { k: 'pago', t: 'Pago' }, { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'concepto', t: 'Concepto' }, { k: 'solicitud', t: 'Solicitud' },
      { k: 'metodo', t: 'Método' }, { k: 'referencia', t: 'Referencia' }, { k: 'monto', t: 'Monto', f: 'dinero' }, { k: 'estado', t: 'Estado', f: 'estado' },
    ],
    enlace: (f) => (f.estado === 'Confirmado' ? `/pagos/recibo/${f.id_pago}` : null),
    async datos(ctx) {
      const where = ['p.id_cliente = ?', ENTRE('p.fecha_pago')], p = [ctx.usuario.id_cliente, ctx.desde, ctx.hasta]
      buscar(ctx, ['p.referencia', 's.codigo_seguimiento'], where, p)
      porEstado(ctx, 'p.estado', where, p)
      const filas = await query(
        `SELECT TOP 1000 p.id_pago, p.fecha_pago AS fecha, p.tipo_pago, p.id_suscripcion, s.codigo_seguimiento AS solicitud, p.metodo_pago AS metodo,
                p.referencia, p.monto, p.estado
           FROM pagos p LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
          WHERE ${where.join(' AND ')} ORDER BY p.fecha_pago DESC`, p)
      return filas.map((x) => ({ ...x, pago: PAG(x.id_pago), concepto: x.id_suscripcion ? 'Plan de suscripción' : CONCEPTO[x.tipo_pago] || x.tipo_pago, solicitud: x.solicitud || '—' }))
    },
    resumen: (f) => [{ t: 'Pagos', v: f.length }, { t: 'Confirmado', v: sum(f.filter((x) => x.estado === 'Confirmado'), 'monto'), f: 'dinero' },
      { t: 'En verificación', v: sum(f.filter((x) => x.estado === 'En verificación'), 'monto'), f: 'dinero' }],
  },
  {
    id: 'cli-facturas', rol: 'Cliente', tipo: 'consulta', titulo: 'Mis facturas y notas', icono: '📄',
    descripcion: 'Desglose de tus facturas y notas: comprobante, prestador, forma de pago, ITBIS, total y modalidad del servicio.',
    filtros: { periodo: 'Fecha de emisión', busqueda: 'e-NCF, número o prestador', estados: ['Emitida', 'Anulada'] },
    columnas: [
      { k: 'numero', t: 'No. factura' }, { k: 'ncf', t: 'No. comprobante (e-NCF)' }, { k: 'fecha', t: 'Fecha de emisión', f: 'fecha' },
      { k: 'prestador', t: 'Prestador' }, { k: 'monto', t: 'Monto', f: 'dinero' }, { k: 'forma_pago', t: 'Forma de pago' },
      { k: 'itbis', t: 'ITBIS', f: 'dinero' }, { k: 'total', t: 'Monto total', f: 'dinero' }, { k: 'modalidad', t: 'Modalidad' },
    ],
    enlace: (f) => `/facturas/${f.numero}`,
    async datos(ctx) {
      const where = ['f.id_cliente = ?', ENTRE('f.fecha_emision')], p = [ctx.usuario.id_cliente, ctx.desde, ctx.hasta]
      buscar(ctx, ['e.ncf', 'f.numero_factura', 'pr.prestador'], where, p)
      porEstado(ctx, 'f.estado', where, p)
      // El pago es el del documento o, en una nota de crédito, el de la factura que modifica
      const filas = await query(
        `SELECT TOP 1000 f.numero_factura AS numero, COALESCE(e.ncf, 'Pendiente') AS ncf, f.fecha_emision AS fecha, f.tipo_documento,
                COALESCE(pr.prestador, IIF(p.id_suscripcion IS NOT NULL, 'Plan de suscripción', '—')) AS prestador,
                ${SIGNO} * (f.subtotal - f.descuento) AS monto, p.metodo_pago, ${SIGNO} * f.itbis AS itbis, ${SIGNO} * f.total AS total,
                s.modalidad
           FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura
           LEFT JOIN facturas fo ON fo.id_factura = f.id_factura_origen
           LEFT JOIN pagos p ON p.id_pago = COALESCE(f.id_pago, fo.id_pago)
           LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud
           OUTER APPLY (SELECT TOP 1 CONCAT(u.nombre, ' ', u.apellido) AS prestador FROM asignaciones_servicio a
                          JOIN empleados em ON em.id_empleado = a.id_empleado JOIN usuarios u ON u.id_usuario = em.id_usuario
                         WHERE a.id_solicitud = s.id_solicitud AND a.estado_asignacion IN ('Aceptada', 'Completada') ORDER BY a.id_asignacion DESC) pr
          WHERE ${where.join(' AND ')} ORDER BY f.fecha_emision DESC, f.id_factura DESC`, p)
      return filas.map((x) => ({
        ...x,
        forma_pago: x.tipo_documento === 'Nota de crédito' ? `Crédito a ${x.metodo_pago || 'cuenta'}` : x.metodo_pago || '—',
        modalidad: !x.modalidad ? '—' : x.modalidad === 'En sitio' ? 'Presencial' : 'Virtual',
      }))
    },
    resumen: (f) => [{ t: 'Documentos', v: f.length }, { t: 'Monto', v: sum(f, 'monto'), f: 'dinero' }, { t: 'ITBIS', v: sum(f, 'itbis'), f: 'dinero' },
      { t: 'Monto total', v: sum(f, 'total'), f: 'dinero' }],
  },
  {
    id: 'cli-prestadores', rol: 'Cliente', tipo: 'consulta', titulo: 'Prestadores por servicio', icono: '🧰',
    descripcion: 'Prestadores aprobados que ofrecen un servicio, con calificación, tarifa y zona.',
    filtros: { busqueda: 'Servicio o prestador', estados: ['Disponible', 'Ocupado'] },
    columnas: [
      { k: 'servicio', t: 'Servicio' }, { k: 'prestador', t: 'Prestador' }, { k: 'especialidad', t: 'Especialidad' },
      { k: 'calificacion', t: 'Calificación', f: 'estrellas' }, { k: 'resenas', t: 'Reseñas', f: 'numero' }, { k: 'tarifa', t: 'Tarifa/hora', f: 'dinero' },
      { k: 'zona', t: 'Zona' }, { k: 'disponibilidad', t: 'Disponibilidad', f: 'estado' },
    ],
    enlace: (f) => `/prestadores/${f.id_empleado}?servicio=${f.id_servicio}`,
    async datos(ctx) {
      const where = ["e.estado_aprobacion = 'Aprobado'", "u.estado IN ('Activo', 'Bloqueado')", "sv.estado = 'Publicado'"], p = []
      buscar(ctx, ['sv.nombre', "CONCAT(u.nombre, ' ', u.apellido)"], where, p)
      porEstado(ctx, 'e.estado_disponibilidad', where, p)
      return query(
        `SELECT TOP 1000 e.id_empleado, sv.id_servicio, sv.nombre AS servicio, CONCAT(u.nombre, ' ', u.apellido) AS prestador, e.especialidad,
                e.calificacion_promedio AS calificacion, e.total_resenas AS resenas, e.tarifa_hora AS tarifa, e.zona_cobertura AS zona, e.estado_disponibilidad AS disponibilidad
           FROM empleado_servicio es JOIN empleados e ON e.id_empleado = es.id_empleado JOIN usuarios u ON u.id_usuario = e.id_usuario
           JOIN servicios sv ON sv.id_servicio = es.id_servicio
          WHERE ${where.join(' AND ')} ORDER BY sv.nombre, e.calificacion_promedio DESC`, p)
    },
    resumen: (f) => [{ t: 'Prestadores', v: new Set(f.map((x) => x.id_empleado)).size }, { t: 'Servicios', v: new Set(f.map((x) => x.id_servicio)).size },
      { t: 'Disponibles ahora', v: new Set(f.filter((x) => x.disponibilidad === 'Disponible').map((x) => x.id_empleado)).size }],
  },
  {
    id: 'cli-estado-cuenta', rol: 'Cliente', tipo: 'reporte', titulo: 'Estado de cuenta', icono: '🧾',
    descripcion: 'Lo pagado, lo que está en verificación y lo reembolsado por mes.',
    filtros: { periodo: 'Fecha del pago' },
    columnas: [
      { k: 'mes', t: 'Mes' }, { k: 'pagos', t: 'Pagos', f: 'numero' }, { k: 'pagado', t: 'Pagado', f: 'dinero' },
      { k: 'en_verificacion', t: 'En verificación', f: 'dinero' }, { k: 'reembolsado', t: 'Reembolsado', f: 'dinero' }, { k: 'neto', t: 'Neto pagado', f: 'dinero' },
    ],
    grafico: { x: 'mes', y: 'neto', f: 'dinero' },
    async datos(ctx) {
      return query(
        `SELECT FORMAT(p.fecha_pago, 'yyyy-MM') AS mes, COUNT(*) AS pagos,
                SUM(IIF(p.estado IN ('Confirmado', 'Reembolsado'), p.monto, 0)) AS pagado,
                SUM(IIF(p.estado = 'En verificación', p.monto, 0)) AS en_verificacion,
                SUM(IIF(p.estado = 'Reembolsado', p.monto, 0)) AS reembolsado,
                SUM(IIF(p.estado = 'Confirmado', p.monto, 0)) AS neto
           FROM pagos p WHERE p.id_cliente = ? AND p.estado IN ('Confirmado', 'En verificación', 'Reembolsado') AND ${ENTRE('p.fecha_pago')}
          GROUP BY FORMAT(p.fecha_pago, 'yyyy-MM') ORDER BY mes`, [ctx.usuario.id_cliente, ctx.desde, ctx.hasta])
    },
    resumen: (f) => [{ t: 'Pagado', v: sum(f, 'pagado'), f: 'dinero' }, { t: 'En verificación', v: sum(f, 'en_verificacion'), f: 'dinero' },
      { t: 'Reembolsado', v: sum(f, 'reembolsado'), f: 'dinero' }, { t: 'Neto pagado', v: sum(f, 'neto'), f: 'dinero' }],
  },
  {
    id: 'cli-fiscal', rol: 'Cliente', tipo: 'reporte', titulo: 'Resumen fiscal', icono: '🏛️',
    descripcion: 'Monto facturado e ITBIS por mes y tipo de comprobante (los e31 sirven para tu formato 606).',
    filtros: { periodo: 'Fecha de emisión', estados: ['e31', 'e32', 'e33', 'e34'], etiquetaEstado: 'Tipo de e-CF' },
    columnas: [
      { k: 'mes', t: 'Mes' }, { k: 'tipo', t: 'Tipo' }, { k: 'documentos', t: 'Documentos', f: 'numero' },
      { k: 'monto', t: 'Monto sin ITBIS', f: 'dinero' }, { k: 'itbis', t: 'ITBIS', f: 'dinero' }, { k: 'total', t: 'Total', f: 'dinero' },
    ],
    grafico: { x: 'mes', y: 'itbis', f: 'dinero', agrupar: true },
    async datos(ctx) {
      const where = ['f.id_cliente = ?', ENTRE('f.fecha_emision'), DOC_ACEPTADO], p = [ctx.usuario.id_cliente, ctx.desde, ctx.hasta]
      porEstado(ctx, 'f.tipo_ecf', where, p)
      return query(
        `SELECT FORMAT(f.fecha_emision, 'yyyy-MM') AS mes, f.tipo_ecf AS tipo, COUNT(*) AS documentos,
                SUM(${SIGNO} * (f.subtotal - f.descuento)) AS monto, SUM(${SIGNO} * f.itbis) AS itbis, SUM(${SIGNO} * f.total) AS total
           FROM facturas f WHERE ${where.join(' AND ')}
          GROUP BY FORMAT(f.fecha_emision, 'yyyy-MM'), f.tipo_ecf ORDER BY mes, tipo`, p)
    },
    resumen: (f) => [{ t: 'Monto sin ITBIS', v: sum(f, 'monto'), f: 'dinero' }, { t: 'ITBIS total', v: sum(f, 'itbis'), f: 'dinero' },
      { t: 'ITBIS en e31 (crédito fiscal)', v: sum(f.filter((x) => x.tipo === 'e31'), 'itbis'), f: 'dinero' }],
  },
  {
    id: 'cli-gasto-categoria', rol: 'Cliente', tipo: 'reporte', titulo: 'Gasto por categoría', icono: '📊',
    descripcion: 'Cuánto gastaste en servicios técnicos, profesionales y del hogar (sin ITBIS).',
    filtros: { periodo: 'Fecha de emisión' },
    columnas: [{ k: 'categoria', t: 'Categoría' }, { k: 'lineas', t: 'Servicios', f: 'numero' }, { k: 'monto', t: 'Gasto sin ITBIS', f: 'dinero' }, { k: 'pct', t: '% del gasto', f: 'pct' }],
    grafico: { x: 'categoria', y: 'monto', f: 'dinero' },
    async datos(ctx) {
      const filas = await query(
        `SELECT COALESCE(cat.nombre, 'Materiales y cargos') AS categoria, COUNT(*) AS lineas, SUM(${SIGNO} * fd.cantidad * fd.precio_unitario) AS monto
           FROM facturas f JOIN factura_detalle fd ON fd.id_factura = f.id_factura
           LEFT JOIN servicios sv ON sv.id_servicio = fd.id_servicio LEFT JOIN categorias_servicio cat ON cat.id_categoria = sv.id_categoria
          WHERE f.id_cliente = ? AND ${ENTRE('f.fecha_emision')} AND ${DOC_ACEPTADO}
          GROUP BY COALESCE(cat.nombre, 'Materiales y cargos') ORDER BY monto DESC`, [ctx.usuario.id_cliente, ctx.desde, ctx.hasta])
      const total = sum(filas, 'monto')
      return filas.map((x) => ({ ...x, pct: total ? round2((x.monto / total) * 100) : 0 }))
    },
    resumen: (f) => [{ t: 'Gasto total sin ITBIS', v: sum(f, 'monto'), f: 'dinero' }, { t: 'Categoría principal', v: f[0]?.categoria || '—' }],
  },
  {
    id: 'cli-plan', rol: 'Cliente', tipo: 'reporte', titulo: 'Uso y ahorro del plan', icono: '⭐',
    descripcion: 'Beneficios de tus planes: servicios incluidos usados y descuentos aplicados, con el ahorro estimado.',
    filtros: { periodo: 'Inicio de la suscripción' },
    columnas: [
      { k: 'plan', t: 'Plan' }, { k: 'periodo', t: 'Periodo' }, { k: 'servicio', t: 'Servicio' }, { k: 'beneficio', t: 'Beneficio' },
      { k: 'usados', t: 'Usados', f: 'numero' }, { k: 'ahorro', t: 'Ahorro estimado', f: 'dinero' },
    ],
    async datos(ctx) {
      const filas = await query(
        `SELECT pl.nombre AS [plan], su.fecha_inicio, su.fecha_renovacion, sv.nombre AS servicio, sv.precio_base, ps.cantidad_incluida, ps.descuento_pct,
                COALESCE(u.usados, 0) AS usados, COALESCE(u.subtotal, 0) AS subtotal
           FROM suscripciones su JOIN planes pl ON pl.id_plan = su.id_plan JOIN plan_servicio ps ON ps.id_plan = pl.id_plan
           JOIN servicios sv ON sv.id_servicio = ps.id_servicio
           OUTER APPLY (SELECT SUM(d.cantidad) AS usados, SUM(d.subtotal) AS subtotal FROM solicitud_detalle d JOIN solicitudes_servicio so ON so.id_solicitud = d.id_solicitud
                         WHERE so.id_cliente = su.id_cliente AND d.id_servicio = ps.id_servicio AND so.estado <> 'Cancelado'
                           AND so.fecha_solicitud >= su.fecha_inicio AND so.fecha_solicitud < su.fecha_renovacion) u
          WHERE su.id_cliente = ? AND su.estado IN ('Activa', 'Cancelada', 'Vencida') AND ${ENTRE('su.fecha_inicio')}
          ORDER BY su.fecha_inicio DESC, sv.nombre`, [ctx.usuario.id_cliente, ctx.desde, ctx.hasta])
      return filas.map((x) => {
        const incl = Number(x.cantidad_incluida)
        const ahorro = incl > 0 ? Math.min(Number(x.usados), incl) * Number(x.precio_base) : Number(x.subtotal) * Number(x.descuento_pct) / 100
        return {
          plan: x.plan, periodo: `${x.fecha_inicio} → ${x.fecha_renovacion}`, servicio: x.servicio,
          beneficio: incl > 0 ? `${incl} incluido(s)` : `${Number(x.descuento_pct)} % de descuento`, usados: Number(x.usados), ahorro: round2(ahorro),
        }
      })
    },
    resumen: (f) => [{ t: 'Ahorro estimado', v: sum(f, 'ahorro'), f: 'dinero' }, { t: 'Servicios usados', v: sum(f, 'usados') }],
  },

  // ================================ PRESTADOR ================================
  {
    id: 'pre-asignaciones', rol: 'Empleado', tipo: 'consulta', titulo: 'Mis asignaciones', icono: '🗂️',
    descripcion: 'Asignaciones recibidas con cliente, dirección, servicio y si ya pagó el anticipo.',
    filtros: { periodo: 'Fecha de asignación', busqueda: 'Código, cliente o dirección', estados: ['Asignada', 'Aceptada', 'Completada', 'Rechazada'] },
    columnas: [
      { k: 'codigo', t: 'Código' }, { k: 'asignada', t: 'Asignada', f: 'fechahora' }, { k: 'cita', t: 'Cita', f: 'fecha' }, { k: 'cliente', t: 'Cliente' },
      { k: 'direccion', t: 'Dirección' }, { k: 'servicio', t: 'Servicio' }, { k: 'anticipo', t: 'Anticipo' }, { k: 'estado', t: 'Estado', f: 'estado' },
    ],
    async datos(ctx) {
      const where = ['a.id_empleado = ?', ENTRE('a.fecha_asignacion')], p = [ctx.usuario.id_empleado, ctx.desde, ctx.hasta]
      buscar(ctx, ['s.codigo_seguimiento', "CONCAT(u.nombre, ' ', u.apellido)", 's.direccion_servicio'], where, p)
      porEstado(ctx, 'a.estado_asignacion', where, p)
      return query(
        `SELECT TOP 1000 s.codigo_seguimiento AS codigo, a.fecha_asignacion AS asignada, s.fecha_preferida AS cita, CONCAT(u.nombre, ' ', u.apellido) AS cliente,
                COALESCE(s.direccion_servicio, 'Remoto') AS direccion,
                (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
                  WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) AS servicio,
                IIF(EXISTS (SELECT 1 FROM pagos pg WHERE pg.id_solicitud = s.id_solicitud AND pg.tipo_pago IN ('Anticipo', 'Total')
                             AND pg.estado IN ('Confirmado', 'En verificación')), 'Pagado', 'Pendiente') AS anticipo,
                a.estado_asignacion AS estado
           FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
           JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY a.fecha_asignacion DESC`, p)
    },
    resumen: (f) => [{ t: 'Asignaciones', v: f.length }, { t: 'Por aceptar', v: f.filter((x) => x.estado === 'Asignada').length },
      { t: 'Completadas', v: f.filter((x) => x.estado === 'Completada').length }],
  },
  {
    id: 'pre-agenda', rol: 'Empleado', tipo: 'consulta', titulo: 'Mi agenda', icono: '📅', periodoInicial: '7d+',
    descripcion: 'Citas aceptadas por día, con hora, cliente, teléfono y sector.',
    filtros: { periodo: 'Fecha de la cita', busqueda: 'Cliente o dirección' },
    columnas: [
      { k: 'cita', t: 'Fecha', f: 'fecha' }, { k: 'hora', t: 'Hora' }, { k: 'codigo', t: 'Código' }, { k: 'cliente', t: 'Cliente' },
      { k: 'telefono', t: 'Teléfono' }, { k: 'direccion', t: 'Dirección' }, { k: 'servicio', t: 'Servicio' }, { k: 'estado', t: 'Estado', f: 'estado' },
    ],
    async datos(ctx) {
      const where = ['a.id_empleado = ?', "a.estado_asignacion IN ('Aceptada', 'Completada')", ENTRE('s.fecha_preferida')], p = [ctx.usuario.id_empleado, ctx.desde, ctx.hasta]
      buscar(ctx, ["CONCAT(u.nombre, ' ', u.apellido)", 's.direccion_servicio'], where, p)
      return query(
        `SELECT TOP 1000 s.fecha_preferida AS cita, LEFT(CONVERT(varchar(8), s.hora_preferida, 108), 5) AS hora, s.codigo_seguimiento AS codigo,
                CONCAT(u.nombre, ' ', u.apellido) AS cliente, u.telefono, COALESCE(s.direccion_servicio, 'Remoto') AS direccion,
                (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
                  WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) AS servicio, s.estado
           FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
           JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY s.fecha_preferida, s.hora_preferida`, p)
    },
    resumen: (f) => [{ t: 'Citas', v: f.length }, { t: 'Días con citas', v: new Set(f.map((x) => x.cita)).size }],
  },
  {
    id: 'pre-efectivo', rol: 'Empleado', tipo: 'consulta', titulo: 'Mis cobros en efectivo', icono: '💵',
    descripcion: 'Recibos de efectivo que reportaste y su estado de conciliación.',
    filtros: { periodo: 'Fecha del cobro', busqueda: 'Recibo o solicitud', estados: ['En verificación', 'Confirmado', 'Rechazado'] },
    columnas: [
      { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'pago', t: 'Pago' }, { k: 'solicitud', t: 'Solicitud' }, { k: 'cliente', t: 'Cliente' },
      { k: 'concepto', t: 'Concepto' }, { k: 'recibo', t: 'Recibo' }, { k: 'monto', t: 'Monto', f: 'dinero' }, { k: 'estado', t: 'Estado', f: 'estado' },
    ],
    async datos(ctx) {
      const where = ["p.metodo_pago = 'Efectivo'", ENTRE('p.fecha_pago'),
        "EXISTS (SELECT 1 FROM asignaciones_servicio a WHERE a.id_solicitud = p.id_solicitud AND a.id_empleado = ? AND a.estado_asignacion IN ('Aceptada', 'Completada'))"]
      const p = [ctx.desde, ctx.hasta, ctx.usuario.id_empleado]
      buscar(ctx, ['p.referencia', 's.codigo_seguimiento'], where, p)
      porEstado(ctx, 'p.estado', where, p)
      const filas = await query(
        `SELECT TOP 1000 p.id_pago, p.fecha_pago AS fecha, s.codigo_seguimiento AS solicitud, CONCAT(u.nombre, ' ', u.apellido) AS cliente, p.tipo_pago,
                p.referencia AS recibo, p.monto, p.estado
           FROM pagos p JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud JOIN clientes c ON c.id_cliente = p.id_cliente
           JOIN usuarios u ON u.id_usuario = c.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY p.fecha_pago DESC`, p)
      return filas.map((x) => ({ ...x, pago: PAG(x.id_pago), concepto: CONCEPTO[x.tipo_pago] || x.tipo_pago }))
    },
    resumen: (f) => [{ t: 'Cobros', v: f.length }, { t: 'Conciliado', v: sum(f.filter((x) => x.estado === 'Confirmado'), 'monto'), f: 'dinero' },
      { t: 'Por conciliar', v: sum(f.filter((x) => x.estado === 'En verificación'), 'monto'), f: 'dinero' }],
  },
  {
    id: 'pre-calificaciones', rol: 'Empleado', tipo: 'consulta', titulo: 'Mis calificaciones', icono: '⭐',
    descripcion: 'Reseñas de tus clientes con estrellas y comentarios.',
    filtros: { periodo: 'Fecha del servicio', busqueda: 'Comentario o cliente', estados: ['5', '4', '3', '2', '1'], etiquetaEstado: 'Estrellas' },
    columnas: [
      { k: 'fecha', t: 'Fecha', f: 'fecha' }, { k: 'codigo', t: 'Solicitud' }, { k: 'cliente', t: 'Cliente' }, { k: 'servicio', t: 'Servicio' },
      { k: 'estrellas', t: 'Calificación', f: 'estrellas' }, { k: 'comentario', t: 'Comentario' },
    ],
    async datos(ctx) {
      const where = ['a.id_empleado = ?', 'a.calificacion_cliente IS NOT NULL', ENTRE('COALESCE(a.fecha_completado, a.fecha_asignacion)')]
      const p = [ctx.usuario.id_empleado, ctx.desde, ctx.hasta]
      buscar(ctx, ['a.comentario_cliente', "CONCAT(u.nombre, ' ', u.apellido)"], where, p)
      if (ctx.estado) { where.push('a.calificacion_cliente = ?'); p.push(Number(ctx.estado)) }
      return query(
        `SELECT TOP 1000 COALESCE(a.fecha_completado, a.fecha_asignacion) AS fecha, s.codigo_seguimiento AS codigo, CONCAT(u.nombre, ' ', u.apellido) AS cliente,
                (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
                  WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) AS servicio,
                a.calificacion_cliente AS estrellas, COALESCE(a.comentario_cliente, '') AS comentario
           FROM asignaciones_servicio a JOIN solicitudes_servicio s ON s.id_solicitud = a.id_solicitud
           JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY fecha DESC`, p)
    },
    resumen: (f) => [{ t: 'Reseñas', v: f.length }, { t: 'Promedio', v: f.length ? round2(sum(f, 'estrellas') / f.length) : 0, f: 'estrellas' },
      { t: '5 estrellas', v: f.filter((x) => x.estrellas === 5).length }],
  },
  {
    id: 'pre-servicios', rol: 'Empleado', tipo: 'reporte', titulo: 'Servicios realizados', icono: '✅',
    descripcion: 'Servicios completados por tipo de servicio, con su calificación promedio.',
    filtros: { periodo: 'Fecha de completado' },
    columnas: [{ k: 'servicio', t: 'Servicio' }, { k: 'completados', t: 'Completados', f: 'numero' }, { k: 'calificacion', t: 'Calificación promedio', f: 'estrellas' }, { k: 'pct', t: '% del total', f: 'pct' }],
    grafico: { x: 'servicio', y: 'completados', f: 'numero' },
    async datos(ctx) {
      const filas = await query(
        `SELECT COALESCE(sv.nombre, 'Otro') AS servicio, COUNT(DISTINCT a.id_asignacion) AS completados,
                CAST(AVG(CAST(a.calificacion_cliente AS DECIMAL(4,2))) AS DECIMAL(3,1)) AS calificacion
           FROM asignaciones_servicio a JOIN solicitud_detalle d ON d.id_solicitud = a.id_solicitud AND d.id_servicio IS NOT NULL
           LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
          WHERE a.id_empleado = ? AND a.estado_asignacion = 'Completada' AND ${ENTRE('a.fecha_completado')}
          GROUP BY sv.nombre ORDER BY completados DESC`, [ctx.usuario.id_empleado, ctx.desde, ctx.hasta])
      const total = sum(filas, 'completados')
      return filas.map((x) => ({ ...x, pct: total ? round2((x.completados / total) * 100) : 0 }))
    },
    resumen: (f) => [{ t: 'Servicios completados', v: sum(f, 'completados') }, { t: 'Más realizado', v: f[0]?.servicio || '—' }],
  },
  {
    id: 'pre-ingresos', rol: 'Empleado', tipo: 'reporte', titulo: 'Ingresos generados', icono: '💰',
    descripcion: 'Pagos confirmados de tus servicios por mes, la comisión de la plataforma y tu neto.',
    filtros: { periodo: 'Fecha del pago' },
    columnas: [
      { k: 'mes', t: 'Mes' }, { k: 'servicios', t: 'Servicios cobrados', f: 'numero' }, { k: 'cobrado', t: 'Cobrado al cliente', f: 'dinero' },
      { k: 'comision', t: 'Comisión', f: 'dinero' }, { k: 'neto', t: 'Tu neto (aprox.)', f: 'dinero' },
    ],
    grafico: { x: 'mes', y: 'cobrado', f: 'dinero' },
    async datos(ctx) {
      const cobros = await query(
        `SELECT FORMAT(p.fecha_pago, 'yyyy-MM') AS mes, COUNT(DISTINCT p.id_solicitud) AS servicios, SUM(p.monto) AS cobrado
           FROM pagos p WHERE p.estado = 'Confirmado' AND ${ENTRE('p.fecha_pago')}
            AND EXISTS (SELECT 1 FROM asignaciones_servicio a WHERE a.id_solicitud = p.id_solicitud AND a.id_empleado = ? AND a.estado_asignacion IN ('Aceptada', 'Completada'))
          GROUP BY FORMAT(p.fecha_pago, 'yyyy-MM')`, [ctx.desde, ctx.hasta, ctx.usuario.id_empleado])
      const comisiones = await query(
        `SELECT FORMAT(COALESCE(a.fecha_completado, a.fecha_asignacion), 'yyyy-MM') AS mes, SUM(COALESCE(a.comision_monto, 0)) AS comision
           FROM asignaciones_servicio a WHERE a.id_empleado = ? AND a.estado_asignacion IN ('Aceptada', 'Completada')
            AND ${ENTRE('COALESCE(a.fecha_completado, a.fecha_asignacion)')}
          GROUP BY FORMAT(COALESCE(a.fecha_completado, a.fecha_asignacion), 'yyyy-MM')`, [ctx.usuario.id_empleado, ctx.desde, ctx.hasta])
      const meses = [...new Set([...cobros.map((x) => x.mes), ...comisiones.map((x) => x.mes)])].sort()
      return meses.map((mes) => {
        const c = cobros.find((x) => x.mes === mes) || {}
        const comision = Number(comisiones.find((x) => x.mes === mes)?.comision || 0)
        return { mes, servicios: c.servicios || 0, cobrado: Number(c.cobrado || 0), comision, neto: round2(Number(c.cobrado || 0) - comision) }
      })
    },
    resumen: (f) => [{ t: 'Cobrado', v: sum(f, 'cobrado'), f: 'dinero' }, { t: 'Comisión', v: sum(f, 'comision'), f: 'dinero' }, { t: 'Neto aproximado', v: sum(f, 'neto'), f: 'dinero' }],
    nota: 'El neto es aproximado: incluye el ITBIS cobrado al cliente. Tu liquidación exacta está en "Mis ganancias".',
  },
  {
    id: 'pre-desempeno', rol: 'Empleado', tipo: 'reporte', titulo: 'Mi desempeño', icono: '📈',
    descripcion: 'Por mes: asignaciones recibidas, aceptadas, rechazadas, completadas y calificación.',
    filtros: { periodo: 'Fecha de asignación' },
    columnas: [
      { k: 'mes', t: 'Mes' }, { k: 'recibidas', t: 'Recibidas', f: 'numero' }, { k: 'aceptadas', t: 'Aceptadas', f: 'numero' },
      { k: 'rechazadas', t: 'Rechazadas o vencidas', f: 'numero' }, { k: 'completadas', t: 'Completadas', f: 'numero' },
      { k: 'tasa', t: 'Tasa de aceptación', f: 'pct' }, { k: 'calificacion', t: 'Calificación', f: 'estrellas' },
    ],
    grafico: { x: 'mes', y: 'tasa', f: 'pct' },
    async datos(ctx) {
      const filas = await query(
        `SELECT FORMAT(a.fecha_asignacion, 'yyyy-MM') AS mes, COUNT(*) AS recibidas,
                SUM(IIF(a.estado_asignacion IN ('Aceptada', 'Completada'), 1, 0)) AS aceptadas,
                SUM(IIF(a.estado_asignacion = 'Rechazada', 1, 0)) AS rechazadas,
                SUM(IIF(a.estado_asignacion = 'Completada', 1, 0)) AS completadas,
                CAST(AVG(CAST(a.calificacion_cliente AS DECIMAL(4,2))) AS DECIMAL(3,1)) AS calificacion
           FROM asignaciones_servicio a WHERE a.id_empleado = ? AND ${ENTRE('a.fecha_asignacion')}
          GROUP BY FORMAT(a.fecha_asignacion, 'yyyy-MM') ORDER BY mes`, [ctx.usuario.id_empleado, ctx.desde, ctx.hasta])
      return filas.map((x) => ({ ...x, tasa: x.recibidas ? round2((x.aceptadas / x.recibidas) * 100) : 0 }))
    },
    resumen: (f) => {
      const rec = sum(f, 'recibidas'), acep = sum(f, 'aceptadas')
      return [{ t: 'Recibidas', v: rec }, { t: 'Tasa de aceptación', v: rec ? round2((acep / rec) * 100) : 0, f: 'pct' }, { t: 'Completadas', v: sum(f, 'completadas') }]
    },
  },
  {
    id: 'pre-cargos', rol: 'Empleado', tipo: 'reporte', titulo: 'Cargos adicionales', icono: '➕',
    descripcion: 'Cargos extra que solicitaste a clientes y su resultado.',
    filtros: { periodo: 'Fecha de la solicitud del cargo', estados: ['Pendiente', 'Aceptado', 'Rechazado', 'Pagado', 'Anulado'] },
    columnas: [
      { k: 'fecha', t: 'Fecha', f: 'fecha' }, { k: 'solicitud', t: 'Solicitud' }, { k: 'descripcion', t: 'Descripción' },
      { k: 'total', t: 'Total con ITBIS', f: 'dinero' }, { k: 'estado', t: 'Estado', f: 'estado' }, { k: 'motivo_rechazo', t: 'Motivo de rechazo' },
    ],
    grafico: { x: 'estado', y: 'total', f: 'dinero', agrupar: true },
    async datos(ctx) {
      const where = ['c.id_empleado = ?', ENTRE('c.fecha_solicitud')], p = [ctx.usuario.id_empleado, ctx.desde, ctx.hasta]
      porEstado(ctx, 'c.estado', where, p)
      return query(
        `SELECT TOP 1000 c.fecha_solicitud AS fecha, s.codigo_seguimiento AS solicitud, c.descripcion,
                ROUND(c.cantidad * c.precio_unitario * IIF(c.aplica_itbis = 1, 1.18, 1), 2) AS total, c.estado, COALESCE(c.motivo_rechazo, '') AS motivo_rechazo
           FROM cargos_adicionales c JOIN solicitudes_servicio s ON s.id_solicitud = c.id_solicitud
          WHERE ${where.join(' AND ')} ORDER BY c.fecha_solicitud DESC`, p)
    },
    resumen: (f) => [{ t: 'Cargos', v: f.length }, { t: 'Pagados', v: sum(f.filter((x) => x.estado === 'Pagado'), 'total'), f: 'dinero' },
      { t: 'Rechazados', v: f.filter((x) => x.estado === 'Rechazado').length }],
  },

  // ================================ ADMINISTRADOR ================================
  {
    id: 'adm-solicitudes', rol: 'Administrador', tipo: 'consulta', titulo: 'Solicitudes', icono: '📋',
    descripcion: 'Todas las solicitudes con cliente, servicio, prestador y estado de la asignación.',
    filtros: { periodo: 'Fecha de la solicitud', busqueda: 'Código, cliente o prestador', estados: ['Pendiente', 'En proceso', 'Completado', 'Cancelado'] },
    columnas: [
      { k: 'codigo', t: 'Código' }, { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'cliente', t: 'Cliente' }, { k: 'servicio', t: 'Servicio' },
      { k: 'prestador', t: 'Prestador' }, { k: 'asignacion', t: 'Asignación', f: 'estado' }, { k: 'cita', t: 'Cita', f: 'fecha' }, { k: 'estado', t: 'Estado', f: 'estado' },
    ],
    async datos(ctx) {
      const where = [ENTRE('s.fecha_solicitud')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ['s.codigo_seguimiento', "CONCAT(uc.nombre, ' ', uc.apellido)", 'pr.prestador'], where, p)
      porEstado(ctx, 's.estado', where, p)
      return query(
        `SELECT TOP 1000 s.codigo_seguimiento AS codigo, s.fecha_solicitud AS fecha, CONCAT(uc.nombre, ' ', uc.apellido) AS cliente,
                (SELECT STRING_AGG(COALESCE(sv.nombre, d.descripcion), ', ') FROM solicitud_detalle d LEFT JOIN servicios sv ON sv.id_servicio = d.id_servicio
                  WHERE d.id_solicitud = s.id_solicitud AND d.id_servicio IS NOT NULL) AS servicio,
                COALESCE(pr.prestador, 'Sin asignar') AS prestador, COALESCE(pr.estado_asignacion, 'Sin asignar') AS asignacion, s.fecha_preferida AS cita, s.estado
           FROM solicitudes_servicio s JOIN clientes c ON c.id_cliente = s.id_cliente JOIN usuarios uc ON uc.id_usuario = c.id_usuario
           OUTER APPLY (SELECT TOP 1 CONCAT(u.nombre, ' ', u.apellido) AS prestador, a.estado_asignacion FROM asignaciones_servicio a
                          JOIN empleados e ON e.id_empleado = a.id_empleado JOIN usuarios u ON u.id_usuario = e.id_usuario
                         WHERE a.id_solicitud = s.id_solicitud ORDER BY IIF(a.estado_asignacion = 'Rechazada', 1, 0), a.id_asignacion DESC) pr
          WHERE ${where.join(' AND ')} ORDER BY s.fecha_solicitud DESC`, p)
    },
    resumen: (f) => [{ t: 'Solicitudes', v: f.length }, { t: 'Sin prestador', v: f.filter((x) => x.estado === 'Pendiente' && ['Sin asignar', 'Rechazada'].includes(x.asignacion)).length },
      { t: 'Completadas', v: f.filter((x) => x.estado === 'Completado').length }],
  },
  {
    id: 'adm-clientes', rol: 'Administrador', tipo: 'consulta', titulo: 'Clientes', icono: '👥',
    descripcion: 'Clientes registrados con su actividad, lo pagado y su plan.',
    filtros: { periodo: 'Fecha de registro', busqueda: 'Nombre, correo o RNC/cédula', estados: ['Persona física', 'Empresa'], etiquetaEstado: 'Tipo' },
    columnas: [
      { k: 'cliente', t: 'Cliente' }, { k: 'email', t: 'Correo' }, { k: 'telefono', t: 'Teléfono' }, { k: 'tipo', t: 'Tipo' }, { k: 'rnc', t: 'RNC / Cédula' },
      { k: 'registro', t: 'Registro', f: 'fecha' }, { k: 'solicitudes', t: 'Solicitudes', f: 'numero' }, { k: 'pagado', t: 'Pagado', f: 'dinero' },
      { k: 'plan', t: 'Plan' }, { k: 'estado', t: 'Cuenta', f: 'estado' },
    ],
    async datos(ctx) {
      const where = [ENTRE('u.fecha_registro')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ["CONCAT(u.nombre, ' ', u.apellido)", 'c.razon_social', 'u.email', 'c.rnc_cedula'], where, p)
      porEstado(ctx, 'c.tipo_cliente', where, p)
      return query(
        `SELECT TOP 1000 COALESCE(c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente, u.email, u.telefono, c.tipo_cliente AS tipo,
                COALESCE(c.rnc_cedula, '') AS rnc, u.fecha_registro AS registro,
                (SELECT COUNT(*) FROM solicitudes_servicio s WHERE s.id_cliente = c.id_cliente) AS solicitudes,
                (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE id_cliente = c.id_cliente AND estado = 'Confirmado') AS pagado,
                COALESCE((SELECT TOP 1 pl.nombre FROM suscripciones su JOIN planes pl ON pl.id_plan = su.id_plan WHERE su.id_cliente = c.id_cliente
                           AND su.estado IN ('Activa', 'Cancelada') AND su.fecha_renovacion >= CAST(GETDATE() AS date) ORDER BY su.id_suscripcion DESC), '—') AS [plan],
                u.estado
           FROM clientes c JOIN usuarios u ON u.id_usuario = c.id_usuario JOIN roles r ON r.id_rol = u.id_rol AND r.nombre_rol = 'Cliente'
          WHERE ${where.join(' AND ')} ORDER BY u.fecha_registro DESC`, p)
    },
    resumen: (f) => [{ t: 'Clientes', v: f.length }, { t: 'Empresas', v: f.filter((x) => x.tipo === 'Empresa').length },
      { t: 'Con solicitudes', v: f.filter((x) => x.solicitudes > 0).length }, { t: 'Total pagado', v: sum(f, 'pagado'), f: 'dinero' }],
  },
  {
    id: 'adm-prestadores', rol: 'Administrador', tipo: 'consulta', titulo: 'Prestadores', icono: '🧰',
    descripcion: 'Prestadores con categoría, zona, estado de aprobación, disponibilidad y calificación.',
    filtros: { busqueda: 'Nombre, especialidad o zona', estados: ['Aprobado', 'Pendiente', 'Rechazado'], etiquetaEstado: 'Aprobación' },
    columnas: [
      { k: 'prestador', t: 'Prestador' }, { k: 'categoria', t: 'Categoría' }, { k: 'especialidad', t: 'Especialidad' }, { k: 'zona', t: 'Zona' },
      { k: 'aprobacion', t: 'Aprobación', f: 'estado' }, { k: 'disponibilidad', t: 'Disponibilidad', f: 'estado' }, { k: 'cuenta', t: 'Cuenta', f: 'estado' },
      { k: 'calificacion', t: 'Calificación', f: 'estrellas' }, { k: 'completados', t: 'Completados', f: 'numero' },
    ],
    async datos(ctx) {
      const where = ['1 = 1'], p = []
      buscar(ctx, ["CONCAT(u.nombre, ' ', u.apellido)", 'e.especialidad', 'e.zona_cobertura'], where, p)
      porEstado(ctx, 'e.estado_aprobacion', where, p)
      return query(
        `SELECT TOP 1000 CONCAT(u.nombre, ' ', u.apellido) AS prestador, cat.nombre AS categoria, e.especialidad, e.zona_cobertura AS zona,
                e.estado_aprobacion AS aprobacion, e.estado_disponibilidad AS disponibilidad, u.estado AS cuenta, e.calificacion_promedio AS calificacion,
                (SELECT COUNT(*) FROM asignaciones_servicio a WHERE a.id_empleado = e.id_empleado AND a.estado_asignacion = 'Completada') AS completados
           FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario JOIN categorias_servicio cat ON cat.id_categoria = e.id_categoria
          WHERE ${where.join(' AND ')} ORDER BY e.estado_aprobacion, completados DESC`, p)
    },
    resumen: (f) => [{ t: 'Prestadores', v: f.length }, { t: 'Aprobados', v: f.filter((x) => x.aprobacion === 'Aprobado').length },
      { t: 'Disponibles', v: f.filter((x) => x.aprobacion === 'Aprobado' && x.disponibilidad === 'Disponible').length }],
  },
  {
    id: 'adm-pagos', rol: 'Administrador', tipo: 'consulta', titulo: 'Pagos', icono: '💳',
    descripcion: 'Todos los pagos con cliente, concepto, método, referencia y quién los concilió.',
    filtros: { periodo: 'Fecha del pago', busqueda: 'Referencia, cliente o solicitud', estados: ['Confirmado', 'En verificación', 'Pendiente', 'Rechazado', 'Reembolsado'] },
    columnas: [
      { k: 'pago', t: 'Pago' }, { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'cliente', t: 'Cliente' }, { k: 'concepto', t: 'Concepto' },
      { k: 'solicitud', t: 'Solicitud' }, { k: 'metodo', t: 'Método' }, { k: 'referencia', t: 'Referencia' }, { k: 'monto', t: 'Monto', f: 'dinero' },
      { k: 'estado', t: 'Estado', f: 'estado' }, { k: 'conciliado_por', t: 'Conciliado por' },
    ],
    async datos(ctx) {
      const where = [ENTRE('p.fecha_pago')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ['p.referencia', "CONCAT(u.nombre, ' ', u.apellido)", 'c.razon_social', 's.codigo_seguimiento'], where, p)
      porEstado(ctx, 'p.estado', where, p)
      const filas = await query(
        `SELECT TOP 1000 p.id_pago, p.fecha_pago AS fecha, COALESCE(c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente, p.tipo_pago, p.id_suscripcion,
                COALESCE(s.codigo_seguimiento, '—') AS solicitud, p.metodo_pago AS metodo, p.referencia, p.monto, p.estado,
                COALESCE(CONCAT(ua.nombre, ' ', ua.apellido), '') AS conciliado_por
           FROM pagos p JOIN clientes c ON c.id_cliente = p.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
           LEFT JOIN solicitudes_servicio s ON s.id_solicitud = p.id_solicitud LEFT JOIN usuarios ua ON ua.id_usuario = p.confirmado_por
          WHERE ${where.join(' AND ')} ORDER BY p.fecha_pago DESC`, p)
      return filas.map((x) => ({ ...x, pago: PAG(x.id_pago), concepto: x.id_suscripcion ? 'Plan de suscripción' : CONCEPTO[x.tipo_pago] || x.tipo_pago }))
    },
    resumen: (f) => [{ t: 'Pagos', v: f.length }, { t: 'Confirmado', v: sum(f.filter((x) => x.estado === 'Confirmado'), 'monto'), f: 'dinero' },
      { t: 'En verificación', v: sum(f.filter((x) => x.estado === 'En verificación'), 'monto'), f: 'dinero' }],
  },
  {
    id: 'adm-ecf', rol: 'Administrador', tipo: 'consulta', titulo: 'Comprobantes e-CF', icono: '🧾',
    descripcion: 'Comprobantes electrónicos con su estado en la DGII y el mensaje de rechazo.',
    filtros: { periodo: 'Fecha de emisión', busqueda: 'e-NCF, número o cliente', estados: ['Aceptado', 'Aceptado condicional', 'En proceso', 'Rechazado'] },
    columnas: [
      { k: 'ncf', t: 'e-NCF' }, { k: 'tipo', t: 'Tipo' }, { k: 'numero', t: 'Documento' }, { k: 'fecha', t: 'Fecha', f: 'fecha' }, { k: 'cliente', t: 'Cliente' },
      { k: 'rnc', t: 'RNC / Cédula' }, { k: 'total', t: 'Total', f: 'dinero' }, { k: 'estado', t: 'Estado DGII', f: 'estado' }, { k: 'mensaje', t: 'Mensaje DGII' },
    ],
    enlace: (f) => `/facturas/${f.numero}`,
    async datos(ctx) {
      const where = [ENTRE('f.fecha_emision')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ['e.ncf', 'f.numero_factura', 'f.razon_social_comprador', "CONCAT(u.nombre, ' ', u.apellido)"], where, p)
      porEstado(ctx, 'e.estado_dgii', where, p)
      return query(
        `SELECT TOP 1000 e.ncf, e.tipo_ecf AS tipo, f.numero_factura AS numero, f.fecha_emision AS fecha,
                COALESCE(f.razon_social_comprador, c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS cliente, COALESCE(f.rnc_comprador, '') AS rnc,
                ${SIGNO} * f.total AS total, e.estado_dgii AS estado, COALESCE(e.mensaje_dgii, '') AS mensaje
           FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura JOIN clientes c ON c.id_cliente = f.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY e.id_ecf DESC`, p)
    },
    resumen: (f) => [{ t: 'Comprobantes', v: f.length }, { t: 'Aceptados', v: f.filter((x) => String(x.estado).startsWith('Aceptado')).length },
      { t: 'Rechazados', v: f.filter((x) => x.estado === 'Rechazado').length }],
  },
  {
    id: 'adm-bitacora', rol: 'Administrador', tipo: 'consulta', titulo: 'Bitácora de auditoría', icono: '🛡️',
    descripcion: 'Quién hizo qué y cuándo: inicios de sesión, aprobaciones, conciliaciones y cambios.',
    filtros: { periodo: 'Fecha', busqueda: 'Acción, usuario o entidad' },
    columnas: [
      { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'usuario', t: 'Usuario' }, { k: 'accion', t: 'Acción' }, { k: 'entidad', t: 'Entidad' },
      { k: 'id_entidad', t: 'ID' }, { k: 'ip', t: 'IP' },
    ],
    async datos(ctx) {
      const where = [ENTRE('b.fecha')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ['b.accion', "CONCAT(u.nombre, ' ', u.apellido)", 'b.entidad'], where, p)
      return query(
        `SELECT TOP 1000 b.fecha, COALESCE(CONCAT(u.nombre, ' ', u.apellido), 'Sistema') AS usuario, b.accion, COALESCE(b.entidad, '') AS entidad,
                COALESCE(CAST(b.id_entidad AS varchar(20)), '') AS id_entidad, COALESCE(b.ip, '') AS ip
           FROM bitacora b LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario
          WHERE ${where.join(' AND ')} ORDER BY b.id_bitacora DESC`, p)
    },
    resumen: (f) => [{ t: 'Eventos', v: f.length }, { t: 'Usuarios distintos', v: new Set(f.map((x) => x.usuario)).size }],
  },
  {
    id: 'adm-ia', rol: 'Administrador', tipo: 'consulta', titulo: 'Conversaciones del asistente IA', icono: '🤖',
    descripcion: 'Qué preguntan los clientes al asistente, qué servicio sugirió y si lo aceptaron.',
    filtros: { periodo: 'Fecha de inicio', busqueda: 'Cliente o pregunta' },
    columnas: [
      { k: 'id', t: '#' }, { k: 'fecha', t: 'Fecha', f: 'fechahora' }, { k: 'cliente', t: 'Cliente' }, { k: 'pregunta', t: 'Primera pregunta' },
      { k: 'sugerido', t: 'Servicio sugerido' }, { k: 'aceptada', t: 'Aceptada' }, { k: 'mensajes', t: 'Mensajes', f: 'numero' }, { k: 'tokens', t: 'Tokens', f: 'numero' },
    ],
    async datos(ctx) {
      const where = [ENTRE('c.fecha_inicio')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ["CONCAT(u.nombre, ' ', u.apellido)", 'pq.pregunta'], where, p)
      return query(
        `SELECT TOP 1000 c.id_conversacion AS id, c.fecha_inicio AS fecha, CONCAT(u.nombre, ' ', u.apellido) AS cliente, COALESCE(pq.pregunta, '') AS pregunta,
                COALESCE((SELECT TOP 1 sv.nombre FROM ia_sugerencias g JOIN servicios sv ON sv.id_servicio = g.id_servicio
                           WHERE g.id_conversacion = c.id_conversacion ORDER BY g.id_sugerencia DESC), '—') AS sugerido,
                IIF(EXISTS (SELECT 1 FROM ia_sugerencias g WHERE g.id_conversacion = c.id_conversacion AND g.aceptada = 1), 'Sí', 'No') AS aceptada,
                (SELECT COUNT(*) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion) AS mensajes,
                (SELECT COALESCE(SUM(tokens), 0) FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion) AS tokens
           FROM ia_conversaciones c JOIN clientes cl ON cl.id_cliente = c.id_cliente JOIN usuarios u ON u.id_usuario = cl.id_usuario
           OUTER APPLY (SELECT TOP 1 LEFT(m.contenido, 120) AS pregunta FROM ia_mensajes m WHERE m.id_conversacion = c.id_conversacion AND m.emisor = 'Cliente'
                         ORDER BY m.id_mensaje) pq
          WHERE ${where.join(' AND ')} ORDER BY c.id_conversacion DESC`, p)
    },
    resumen: (f) => [{ t: 'Conversaciones', v: f.length }, { t: 'Con sugerencia aceptada', v: f.filter((x) => x.aceptada === 'Sí').length }, { t: 'Tokens', v: sum(f, 'tokens') }],
  },
  {
    id: 'adm-catalogo', rol: 'Administrador', tipo: 'reporte', titulo: 'Servicios, prestadores, modalidad y costo', icono: '🗃️',
    descripcion: 'Catálogo de servicios con categoría, modalidad (presencial o virtual), precio base, duración y los prestadores que ofrecen cada uno con su tarifa.',
    filtros: { busqueda: 'Servicio, categoría o prestador', estados: ['Presencial', 'Virtual'], etiquetaEstado: 'Modalidad' },
    columnas: [
      { k: 'servicio', t: 'Servicio' }, { k: 'categoria', t: 'Categoría' }, { k: 'modalidad', t: 'Modalidad' }, { k: 'precio', t: 'Costo (precio base)', f: 'dinero' },
      { k: 'duracion', t: 'Duración' }, { k: 'prestador', t: 'Prestador' }, { k: 'tarifa', t: 'Tarifa del prestador/hora', f: 'dinero' },
      { k: 'disponibilidad', t: 'Disponibilidad', f: 'estado' }, { k: 'estado', t: 'Estado del servicio', f: 'estado' },
    ],
    async datos(ctx) {
      const where = ['1 = 1'], p = []
      buscar(ctx, ['sv.nombre', 'cat.nombre', 'pr.prestador'], where, p)
      // "Ambas" cuenta como presencial y como virtual
      if (ctx.estado === 'Presencial') where.push("sv.modalidad IN ('En sitio', 'Ambas')")
      if (ctx.estado === 'Virtual') where.push("sv.modalidad IN ('Remoto', 'Virtual', 'Ambas')")
      const filas = await query(
        `SELECT TOP 1000 sv.id_servicio, sv.nombre AS servicio, cat.nombre AS categoria, sv.modalidad, sv.precio_base AS precio, sv.duracion_estimada,
                COALESCE(pr.prestador, 'Sin prestador asignado') AS prestador, pr.tarifa, pr.disponibilidad, sv.estado
           FROM servicios sv JOIN categorias_servicio cat ON cat.id_categoria = sv.id_categoria
           LEFT JOIN (SELECT es.id_servicio, CONCAT(u.nombre, ' ', u.apellido) AS prestador, e.tarifa_hora AS tarifa, e.estado_disponibilidad AS disponibilidad
                        FROM empleado_servicio es JOIN empleados e ON e.id_empleado = es.id_empleado JOIN usuarios u ON u.id_usuario = e.id_usuario
                       WHERE e.estado_aprobacion = 'Aprobado') pr ON pr.id_servicio = sv.id_servicio
          WHERE ${where.join(' AND ')} ORDER BY cat.nombre, sv.nombre, pr.prestador`, p)
      const MODALIDAD = { 'En sitio': 'Presencial', Remoto: 'Virtual', Virtual: 'Virtual', Ambas: 'Presencial y virtual' }
      return filas.map((x) => ({
        ...x, modalidad: MODALIDAD[x.modalidad] || x.modalidad,
        duracion: x.duracion_estimada ? (x.duracion_estimada >= 60 ? `${Math.round((x.duracion_estimada / 60) * 10) / 10} h` : `${x.duracion_estimada} min`) : '—',
      }))
    },
    resumen: (f) => {
      const servicios = new Map(f.map((x) => [x.id_servicio, x]))
      const lista = [...servicios.values()]
      return [{ t: 'Servicios', v: lista.length }, { t: 'Presenciales', v: lista.filter((x) => x.modalidad !== 'Virtual').length },
        { t: 'Virtuales', v: lista.filter((x) => x.modalidad !== 'Presencial').length },
        { t: 'Sin prestador', v: lista.filter((x) => x.prestador === 'Sin prestador asignado').length },
        { t: 'Precio promedio', v: lista.length ? round2(lista.reduce((s, x) => s + Number(x.precio), 0) / lista.length) : 0, f: 'dinero' }]
    },
    nota: 'Hay una fila por cada prestador que ofrece el servicio. "Presencial y virtual" significa que el servicio admite las dos modalidades.',
  },
  {
    id: 'adm-ingresos-metodo', rol: 'Administrador', tipo: 'reporte', titulo: 'Ingresos por periodo y método', icono: '💵',
    descripcion: 'Pagos confirmados por mes y método de pago.',
    filtros: { periodo: 'Fecha del pago' },
    columnas: [
      { k: 'mes', t: 'Mes' }, { k: 'PayPal', t: 'PayPal', f: 'dinero' }, { k: 'Tarjeta', t: 'Tarjeta', f: 'dinero' }, { k: 'Transferencia', t: 'Transferencia', f: 'dinero' },
      { k: 'Efectivo', t: 'Efectivo', f: 'dinero' }, { k: 'pagos', t: 'Cantidad de pagos (todos los métodos)', f: 'numero' }, { k: 'total', t: 'Total', f: 'dinero' },
    ],
    grafico: { x: 'mes', y: 'total', f: 'dinero' },
    async datos(ctx) {
      return query(
        `SELECT FORMAT(p.fecha_pago, 'yyyy-MM') AS mes,
                SUM(IIF(p.metodo_pago = 'PayPal', p.monto, 0)) AS PayPal, SUM(IIF(p.metodo_pago = 'Tarjeta', p.monto, 0)) AS Tarjeta,
                SUM(IIF(p.metodo_pago = 'Transferencia', p.monto, 0)) AS Transferencia, SUM(IIF(p.metodo_pago = 'Efectivo', p.monto, 0)) AS Efectivo,
                COUNT(*) AS pagos, SUM(p.monto) AS total
           FROM pagos p WHERE p.estado = 'Confirmado' AND ${ENTRE('p.fecha_pago')}
          GROUP BY FORMAT(p.fecha_pago, 'yyyy-MM') ORDER BY mes`, [ctx.desde, ctx.hasta])
    },
    resumen: (f) => [{ t: 'Total', v: sum(f, 'total'), f: 'dinero' }, { t: 'PayPal', v: sum(f, 'PayPal'), f: 'dinero' }, { t: 'Tarjeta', v: sum(f, 'Tarjeta'), f: 'dinero' },
      { t: 'Transferencia', v: sum(f, 'Transferencia'), f: 'dinero' }, { t: 'Efectivo', v: sum(f, 'Efectivo'), f: 'dinero' }],
  },
  {
    id: 'adm-ingresos-servicio', rol: 'Administrador', tipo: 'reporte', titulo: 'Ingresos por servicio y categoría', icono: '🏷️',
    descripcion: 'Facturado por servicio (comprobantes aceptados; las notas de crédito restan).',
    filtros: { periodo: 'Fecha de emisión', estados: ['Técnicos', 'Profesionales', 'Hogar'], etiquetaEstado: 'Categoría' },
    columnas: [
      { k: 'categoria', t: 'Categoría' }, { k: 'servicio', t: 'Servicio' }, { k: 'lineas', t: 'Líneas', f: 'numero' },
      { k: 'subtotal', t: 'Sin ITBIS', f: 'dinero' }, { k: 'itbis', t: 'ITBIS', f: 'dinero' }, { k: 'total', t: 'Total', f: 'dinero' },
    ],
    grafico: { x: 'servicio', y: 'subtotal', f: 'dinero', limite: 10 },
    async datos(ctx) {
      const where = [ENTRE('f.fecha_emision'), DOC_ACEPTADO], p = [ctx.desde, ctx.hasta]
      porEstado(ctx, 'cat.nombre', where, p)
      return query(
        `SELECT COALESCE(cat.nombre, 'Materiales y cargos') AS categoria, COALESCE(sv.nombre, 'Materiales y cargos') AS servicio, COUNT(*) AS lineas,
                SUM(${SIGNO} * fd.cantidad * fd.precio_unitario) AS subtotal, SUM(${SIGNO} * fd.itbis_linea) AS itbis, SUM(${SIGNO} * fd.total_linea) AS total
           FROM facturas f JOIN factura_detalle fd ON fd.id_factura = f.id_factura
           LEFT JOIN servicios sv ON sv.id_servicio = fd.id_servicio LEFT JOIN categorias_servicio cat ON cat.id_categoria = sv.id_categoria
          WHERE ${where.join(' AND ')}
          GROUP BY cat.nombre, sv.nombre ORDER BY subtotal DESC`, p)
    },
    resumen: (f) => [{ t: 'Facturado sin ITBIS', v: sum(f, 'subtotal'), f: 'dinero' }, { t: 'ITBIS', v: sum(f, 'itbis'), f: 'dinero' }, { t: 'Servicio líder', v: f[0]?.servicio || '—' }],
  },
  {
    id: 'adm-tiempos', rol: 'Administrador', tipo: 'reporte', titulo: 'Solicitudes y tiempos de atención', icono: '⏱️',
    descripcion: 'Solicitudes por estado y horas promedio hasta asignar, completar y cerrar.',
    filtros: { periodo: 'Fecha de la solicitud' },
    columnas: [
      { k: 'estado', t: 'Estado', f: 'estado' }, { k: 'cantidad', t: 'Solicitudes', f: 'numero' }, { k: 'pct', t: '% del total', f: 'pct' },
      { k: 'h_asignacion', t: 'Horas hasta asignar', f: 'numero' }, { k: 'h_completado', t: 'Horas hasta completar', f: 'numero' }, { k: 'h_cierre', t: 'Horas hasta cerrar', f: 'numero' },
    ],
    grafico: { x: 'estado', y: 'cantidad', f: 'numero' },
    async datos(ctx) {
      const filas = await query(
        `SELECT s.estado, COUNT(*) AS cantidad,
                CAST(AVG(CAST(DATEDIFF(MINUTE, s.fecha_solicitud, a.primera) AS FLOAT)) / 60 AS DECIMAL(10,1)) AS h_asignacion,
                CAST(AVG(CAST(DATEDIFF(MINUTE, s.fecha_solicitud, a.completado) AS FLOAT)) / 60 AS DECIMAL(10,1)) AS h_completado,
                CAST(AVG(CAST(DATEDIFF(MINUTE, s.fecha_solicitud, s.fecha_finalizacion) AS FLOAT)) / 60 AS DECIMAL(10,1)) AS h_cierre
           FROM solicitudes_servicio s
           OUTER APPLY (SELECT MIN(fecha_asignacion) AS primera, MAX(fecha_completado) AS completado FROM asignaciones_servicio WHERE id_solicitud = s.id_solicitud) a
          WHERE ${ENTRE('s.fecha_solicitud')} GROUP BY s.estado ORDER BY cantidad DESC`, [ctx.desde, ctx.hasta])
      const total = sum(filas, 'cantidad')
      return filas.map((x) => ({ ...x, pct: total ? round2((x.cantidad / total) * 100) : 0 }))
    },
    resumen: (f) => {
      const total = sum(f, 'cantidad'), canc = f.find((x) => x.estado === 'Cancelado')?.cantidad || 0
      return [{ t: 'Solicitudes', v: total }, { t: 'Tasa de cancelación', v: total ? round2((canc / total) * 100) : 0, f: 'pct' }]
    },
  },
  {
    id: 'adm-ranking', rol: 'Administrador', tipo: 'reporte', titulo: 'Ranking de prestadores', icono: '🏆',
    descripcion: 'Servicios completados, cobrado, comisión, calificación y tasa de aceptación por prestador.',
    filtros: { periodo: 'Fecha de asignación' },
    columnas: [
      { k: 'prestador', t: 'Prestador' }, { k: 'especialidad', t: 'Especialidad' }, { k: 'recibidas', t: 'Recibidas', f: 'numero' },
      { k: 'completadas', t: 'Completadas', f: 'numero' }, { k: 'tasa', t: 'Aceptación', f: 'pct' }, { k: 'cobrado', t: 'Cobrado', f: 'dinero' },
      { k: 'comision', t: 'Comisión', f: 'dinero' }, { k: 'calificacion', t: 'Calificación', f: 'estrellas' },
    ],
    grafico: { x: 'prestador', y: 'completadas', f: 'numero', limite: 10 },
    async datos(ctx) {
      const filas = await query(
        `SELECT CONCAT(u.nombre, ' ', u.apellido) AS prestador, e.especialidad, COUNT(a.id_asignacion) AS recibidas,
                SUM(IIF(a.estado_asignacion IN ('Aceptada', 'Completada'), 1, 0)) AS aceptadas, SUM(IIF(a.estado_asignacion = 'Completada', 1, 0)) AS completadas,
                SUM(IIF(a.estado_asignacion IN ('Aceptada', 'Completada'), COALESCE(a.comision_monto, 0), 0)) AS comision,
                SUM(IIF(a.estado_asignacion IN ('Aceptada', 'Completada'), a.cobrado, 0)) AS cobrado,
                e.calificacion_promedio AS calificacion
           FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
           LEFT JOIN (SELECT x.*, (SELECT COALESCE(SUM(p.monto), 0) FROM pagos p WHERE p.id_solicitud = x.id_solicitud AND p.estado = 'Confirmado') AS cobrado
                        FROM asignaciones_servicio x WHERE ${ENTRE('x.fecha_asignacion')}) a ON a.id_empleado = e.id_empleado
          WHERE e.estado_aprobacion = 'Aprobado'
          GROUP BY u.nombre, u.apellido, e.especialidad, e.calificacion_promedio
          ORDER BY completadas DESC, cobrado DESC`, [ctx.desde, ctx.hasta])
      return filas.map((x) => ({ ...x, tasa: x.recibidas ? round2((x.aceptadas / x.recibidas) * 100) : 0 }))
    },
    resumen: (f) => [{ t: 'Prestadores', v: f.length }, { t: 'Completadas', v: sum(f, 'completadas') }, { t: 'Comisiones', v: sum(f, 'comision'), f: 'dinero' }],
  },
  {
    id: 'adm-zonas', rol: 'Administrador', tipo: 'reporte', titulo: 'Demanda vs. cobertura por zona', icono: '🗺️',
    descripcion: 'Solicitudes en sitio por sector comparadas con los prestadores que cubren ese sector.',
    filtros: { periodo: 'Fecha de la solicitud' },
    columnas: [
      { k: 'zona', t: 'Sector' }, { k: 'solicitudes', t: 'Solicitudes', f: 'numero' }, { k: 'sin_prestador', t: 'Sin prestador', f: 'numero' },
      { k: 'prestadores', t: 'Prestadores que lo cubren', f: 'numero' }, { k: 'situacion', t: 'Situación', f: 'estado' },
    ],
    grafico: { x: 'zona', y: 'solicitudes', f: 'numero', limite: 12 },
    async datos(ctx) {
      const sols = await query(
        `SELECT s.direccion_servicio, s.estado,
                IIF(EXISTS (SELECT 1 FROM asignaciones_servicio a WHERE a.id_solicitud = s.id_solicitud AND a.estado_asignacion <> 'Rechazada'), 1, 0) AS asignada
           FROM solicitudes_servicio s WHERE s.modalidad = 'En sitio' AND ${ENTRE('s.fecha_solicitud')}`, [ctx.desde, ctx.hasta])
      const prest = await query(
        `SELECT e.zona_cobertura FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
          WHERE e.estado_aprobacion = 'Aprobado' AND u.estado <> 'Inactivo'`)
      const zonas = new Map()
      const agregar = (z) => { const k = normal(z.trim()); if (k && !zonas.has(k)) zonas.set(k, z.trim()) }
      SECTORES_SANTIAGO.forEach(agregar)
      prest.forEach((p) => (p.zona_cobertura || '').split(',').forEach(agregar))
      const filas = [...zonas].map(([k, nombre]) => {
        const enZona = sols.filter((s) => normal(s.direccion_servicio || '').includes(k))
        const cubren = prest.filter((p) => (p.zona_cobertura || '').split(',').some((z) => normal(z.trim()) === k)).length
        return { zona: nombre, solicitudes: enZona.length, sin_prestador: enZona.filter((s) => !s.asignada && s.estado !== 'Cancelado').length, prestadores: cubren }
      }).filter((x) => x.solicitudes || x.prestadores)
      const reconocidas = new Set()
      for (const s of sols) for (const k of zonas.keys()) if (normal(s.direccion_servicio || '').includes(k)) reconocidas.add(s)
      const otras = sols.filter((s) => !reconocidas.has(s))
      if (otras.length) filas.push({ zona: 'Sector no reconocido', solicitudes: otras.length, sin_prestador: otras.filter((s) => !s.asignada && s.estado !== 'Cancelado').length, prestadores: 0 })
      return filas.map((x) => ({
        ...x, situacion: x.zona === 'Sector no reconocido' ? 'Revisar' : !x.prestadores && x.solicitudes ? 'Sin cobertura' : !x.prestadores ? 'Sin cobertura' : x.solicitudes > x.prestadores * 5 ? 'Falta personal' : 'Cubierta',
      })).sort((a, b) => b.solicitudes - a.solicitudes || b.prestadores - a.prestadores)
    },
    resumen: (f) => [{ t: 'Sectores con demanda', v: f.filter((x) => x.solicitudes).length }, { t: 'Sin cobertura', v: f.filter((x) => x.situacion === 'Sin cobertura').length },
      { t: 'Solicitudes sin prestador', v: sum(f, 'sin_prestador') }],
    nota: 'El sector se reconoce cuando la dirección del cliente contiene el nombre del sector.',
  },
  {
    id: 'adm-607', rol: 'Administrador', tipo: 'reporte', titulo: 'Formato 607 (DGII)', icono: '🏛️',
    descripcion: 'Ventas con e-NCF aceptados: RNC del comprador, monto, ITBIS y NCF modificado.',
    filtros: { periodo: 'Fecha de emisión', estados: ['e31', 'e32', 'e33', 'e34'], etiquetaEstado: 'Tipo de e-CF' },
    columnas: [
      { k: 'rnc', t: 'RNC / Cédula' }, { k: 'tipo_id', t: 'Tipo ID' }, { k: 'ncf', t: 'e-NCF' }, { k: 'ncf_modificado', t: 'NCF modificado' },
      { k: 'fecha', t: 'Fecha', f: 'fecha' }, { k: 'monto', t: 'Monto facturado', f: 'dinero' }, { k: 'itbis', t: 'ITBIS facturado', f: 'dinero' },
    ],
    async datos(ctx) {
      const where = [ENTRE('f.fecha_emision'), "e.estado_dgii LIKE 'Aceptado%'"], p = [ctx.desde, ctx.hasta]
      porEstado(ctx, 'e.tipo_ecf', where, p)
      const filas = await query(
        `SELECT COALESCE(f.rnc_comprador, '') AS rnc, e.ncf, COALESCE(eo.ncf, '') AS ncf_modificado, f.fecha_emision AS fecha,
                f.subtotal - f.descuento AS monto, f.itbis
           FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura LEFT JOIN ecf eo ON eo.id_factura = f.id_factura_origen
          WHERE ${where.join(' AND ')} ORDER BY e.ncf`, p)
      return filas.map((x) => ({ ...x, tipo_id: x.rnc.length === 9 ? '1 (RNC)' : x.rnc.length === 11 ? '2 (Cédula)' : '' }))
    },
    resumen: (f) => [{ t: 'Comprobantes', v: f.length }, { t: 'Monto facturado', v: sum(f, 'monto'), f: 'dinero' }, { t: 'ITBIS facturado', v: sum(f, 'itbis'), f: 'dinero' }],
  },
  {
    id: 'adm-notas-planes', rol: 'Administrador', tipo: 'reporte', titulo: 'Notas de crédito, reembolsos y suscripciones', icono: '↩️',
    descripcion: 'Notas de crédito emitidas con su origen y devolución, más el estado de las suscripciones.',
    filtros: { periodo: 'Fecha de emisión', busqueda: 'Cliente, e-NCF o motivo' },
    columnas: [
      { k: 'fecha', t: 'Fecha', f: 'fecha' }, { k: 'nota', t: 'Nota' }, { k: 'ncf', t: 'e-NCF' }, { k: 'modifica', t: 'Modifica' }, { k: 'cliente', t: 'Cliente' },
      { k: 'origen', t: 'Origen' }, { k: 'motivo', t: 'Motivo' }, { k: 'total', t: 'Monto', f: 'dinero' }, { k: 'devolucion', t: 'Devolución', f: 'estado' },
    ],
    async datos(ctx) {
      const where = ["f.tipo_documento = 'Nota de crédito'", ENTRE('f.fecha_emision')], p = [ctx.desde, ctx.hasta]
      buscar(ctx, ['f.razon_social_comprador', "CONCAT(u.nombre, ' ', u.apellido)", 'e.ncf', 'f.razon_modificacion'], where, p)
      const filas = await query(
        `SELECT TOP 1000 f.fecha_emision AS fecha, f.numero_factura AS nota, COALESCE(e.ncf, '') AS ncf, COALESCE(eo.ncf, fo.numero_factura) AS modifica,
                COALESCE(f.razon_social_comprador, CONCAT(u.nombre, ' ', u.apellido)) AS cliente, COALESCE(f.razon_modificacion, '') AS motivo, f.total,
                snc.id_solicitud_nc, snc.requiere_devolucion, snc.fecha_devolucion,
                (SELECT TOP 1 1 FROM facturas r WHERE r.id_factura_origen = fo.id_factura AND r.tipo_documento = 'Factura') AS sustitucion
           FROM facturas f LEFT JOIN ecf e ON e.id_factura = f.id_factura LEFT JOIN facturas fo ON fo.id_factura = f.id_factura_origen
           LEFT JOIN ecf eo ON eo.id_factura = fo.id_factura JOIN clientes c ON c.id_cliente = f.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
           LEFT JOIN solicitudes_nota_credito snc ON snc.id_nota = f.id_factura
          WHERE ${where.join(' AND ')} ORDER BY f.fecha_emision DESC`, p)
      return filas.map((x) => ({
        ...x,
        origen: x.id_solicitud_nc ? 'Solicitud del cliente' : x.sustitucion ? 'Cambio a crédito fiscal' : /^Reembolso/.test(x.motivo) ? 'Reembolso' : 'Administración',
        devolucion: x.requiere_devolucion ? (x.fecha_devolucion ? 'Devuelto' : 'Pendiente') : 'No aplica',
      }))
    },
    async resumenAsync(f) {
      const s = (await query(
        `SELECT SUM(IIF(su.estado = 'Activa', 1, 0)) AS activas, SUM(IIF(su.estado = 'Cancelada' AND su.fecha_renovacion >= CAST(GETDATE() AS date), 1, 0)) AS canceladas,
                SUM(IIF(su.estado = 'Activa', pl.precio_mensual, 0)) AS recurrente
           FROM suscripciones su JOIN planes pl ON pl.id_plan = su.id_plan`))[0]
      return [{ t: 'Notas de crédito', v: f.length }, { t: 'Monto acreditado', v: sum(f, 'total'), f: 'dinero' },
        { t: 'Devoluciones pendientes', v: f.filter((x) => x.devolucion === 'Pendiente').length },
        { t: 'Suscripciones activas', v: s.activas || 0 }, { t: 'Ingreso mensual recurrente', v: Number(s.recurrente || 0), f: 'dinero' }]
    },
  },
]

const ROLES_REPORTE = { Cliente: 'Cliente', Empleado: 'Empleado', Administrador: 'Administrador' }

/** Catálogo visible para el rol (sin la lógica interna). */
export function catalogoReportes(rol) {
  return REPORTES.filter((r) => r.rol === ROLES_REPORTE[rol]).map(({ id, tipo, titulo, descripcion, icono, filtros, columnas, grafico, periodoInicial, nota }) => (
    { id, tipo, titulo, descripcion, icono, filtros, columnas, grafico: grafico || null, periodoInicial: periodoInicial || null, nota: nota || null, enlaces: false }))
}

/** Ejecuta una consulta o reporte para el usuario conectado. */
export async function ejecutarReporte(id, usuario, q) {
  const def = REPORTES.find((r) => r.id === id)
  if (!def || def.rol !== ROLES_REPORTE[usuario.nombre_rol]) return null
  const fecha = (v, porDefecto) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : porDefecto)
  const ctx = {
    usuario, desde: fecha(q.desde, '1900-01-01'), hasta: fecha(q.hasta, '2999-12-31'),
    q: String(q.q || '').trim().slice(0, 80) || null,
    estado: def.filtros.estados?.includes(q.estado) ? q.estado : null,
  }
  const filas = await def.datos(ctx)
  const resumen = def.resumenAsync ? await def.resumenAsync(filas) : def.resumen ? def.resumen(filas) : []
  return { def, ctx, filas: def.enlace ? filas.map((f) => ({ ...f, _enlace: def.enlace(f) })) : filas, resumen }
}

/** CSV (Excel) con los títulos de las columnas. */
export function reporteCsv({ def, filas, resumen }) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : String(v)
    return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lineas = [def.columnas.map((c) => esc(c.t)).join(',')]
  for (const f of filas) lineas.push(def.columnas.map((c) => esc(f[c.k])).join(','))
  if (resumen.length) {
    lineas.push('')
    for (const r of resumen) lineas.push(`${esc(r.t)},${esc(r.v)}`)
  }
  return `\uFEFF${lineas.join('\r\n')}` // \uFEFF (BOM): Excel lee bien las tildes
}
