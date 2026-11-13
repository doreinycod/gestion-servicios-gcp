// =====================================================================
// MOD-ADM · Administración
// ADM-P01 Acceso y registro · ADM-P02 Dashboard · ADM-P03 Aprobación de prestadores · ADM-P04 Usuarios y roles · ADM-P05 Reportes · ADM-P06 Notificaciones y bitácora
// =====================================================================
import { exec, query, one, transaction, AHORA } from '../config/db.js'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { enviarCorreo } from '../lib/correo.js'
import { autenticar, firmarToken, soloRol } from '../middleware/auth.js'
import { HttpError, badRequest, conflict, validar, notFound } from '../lib/http.js'
import { cedulaValida, rncValido, emailValido, telefonoValido, contrasenaValida, nombreValido } from '../lib/fiscal.js'
import { upload, urlArchivo } from '../lib/upload.js'
import { estadoCobro } from '../lib/totales.js'

/**
 * ADM-P06 · Servicio transversal de notificaciones.
 * Registra el aviso en la app y deja constancia de los canales correo / WhatsApp.
 * El envío real (SMTP, WhatsApp Business API) se conectará aquí.
 */
export async function notificar(id_usuario, { tipo = 'Sistema', titulo, mensaje, canales = ['App'] }, cx) {
  if (!id_usuario) return
  for (const canal of canales) {
    await exec(
      'INSERT INTO notificaciones (id_usuario, tipo, canal, titulo, mensaje) VALUES (?, ?, ?, ?, ?)',
      [id_usuario, tipo, canal, titulo.slice(0, 100), mensaje.slice(0, 500)],
      cx,
    )
  }
}

/** Notifica a todos los administradores activos. */
export async function notificarAdmins(datos, cx) {
  const admins = await query(
    `SELECT u.id_usuario FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
      WHERE r.nombre_rol = 'Administrador' AND u.estado = 'Activo'`,
    [],
    cx,
  )
  for (const a of admins) await notificar(a.id_usuario, datos, cx)
}

/** Bitácora de auditoría (sección 25.3). */
export async function auditar(req, accion, entidad, id_entidad, anterior = null, nuevo = null, cx) {
  await exec(
    `INSERT INTO bitacora (id_usuario, accion, entidad, id_entidad, valor_anterior, valor_nuevo, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      req?.usuario?.id_usuario ?? null, accion, entidad, id_entidad ?? null,
      anterior ? JSON.stringify(anterior) : null, nuevo ? JSON.stringify(nuevo) : null,
      req?.ip ?? null,
    ],
    cx,
  )
}

const rAuth = Router()
const MAX_INTENTOS = 3
const BLOQUEO_MIN = 15
const soloDigitos = (v = '') => String(v).replace(/\D/g, '')

/** Perfil de sesión que recibe el frontend (v_usuarioActivo + v_rolActivo). */
export async function perfil(id_usuario) {
  return one(
    `SELECT u.id_usuario, u.nombre, u.apellido, u.email, u.telefono, u.estado, u.ultimo_acceso,
            r.nombre_rol AS rol, c.id_cliente, c.tipo_cliente, c.rnc_cedula, c.razon_social, c.direccion, c.ciudad,
            e.id_empleado, e.especialidad, e.estado_aprobacion
       FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol
       LEFT JOIN clientes c ON c.id_usuario = u.id_usuario
       LEFT JOIN empleados e ON e.id_usuario = u.id_usuario
      WHERE u.id_usuario = ?`,
    [id_usuario],
  )
}

// ADM-P01 · Inicio de sesión: bcrypt, 3 intentos → bloqueo 15 min, bitácora
rAuth.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const contrasena = String(req.body.contrasena || '')
  validar({ email: !emailValido(email) && 'Formato de correo inválido', contrasena: !contrasena && 'Indique la contraseña' })

  const u = await one(
    'SELECT u.*, r.nombre_rol FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE u.email = ?',
    [email],
  )
  const credencialesInvalidas = new HttpError(401, 'Correo o contraseña incorrectos')
  if (!u) throw credencialesInvalidas

  if (u.estado === 'Bloqueado') {
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) <= new Date()) {
      await exec("UPDATE usuarios SET estado = 'Activo', intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?", [u.id_usuario])
      u.estado = 'Activo'
    } else {
      throw new HttpError(423, `Cuenta bloqueada por intentos fallidos. Intente de nuevo después de ${BLOQUEO_MIN} minutos o contacte al administrador.`)
    }
  }

  if (!(await bcrypt.compare(contrasena, u.contrasena_hash))) {
    const intentos = u.intentos_fallidos + 1
    if (intentos >= MAX_INTENTOS) {
      await exec(
        `UPDATE usuarios SET intentos_fallidos = ?, estado = 'Bloqueado', bloqueado_hasta = DATEADD(MINUTE, ?, ${AHORA}) WHERE id_usuario = ?`,
        [intentos, BLOQUEO_MIN, u.id_usuario],
      )
      await auditar(req, 'Cuenta bloqueada por intentos fallidos', 'usuarios', u.id_usuario)
      throw new HttpError(423, `Cuenta bloqueada ${BLOQUEO_MIN} minutos por ${MAX_INTENTOS} intentos fallidos.`)
    }
    await exec('UPDATE usuarios SET intentos_fallidos = ? WHERE id_usuario = ?', [intentos, u.id_usuario])
    throw credencialesInvalidas
  }

  if (u.estado === 'Inactivo') {
    throw new HttpError(403, u.nombre_rol === 'Empleado'
      ? 'Tu perfil de prestador está pendiente de aprobación.'
      : 'La cuenta está inactiva. Contacte al administrador.')
  }

  await exec(`UPDATE usuarios SET intentos_fallidos = 0, ultimo_acceso = ${AHORA} WHERE id_usuario = ?`, [u.id_usuario])
  await auditar({ ...req, usuario: u }, 'Inicio de sesión', 'usuarios', u.id_usuario)
  res.json({ token: firmarToken(u), usuario: await perfil(u.id_usuario) })
})

// ---------- ADM-P01 · ¿Olvidaste tu contraseña? ----------
const MIN_VIGENCIA_ENLACE = 30
const MAX_ENLACES_HORA = 3
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

/**
 * Pide el enlace para restablecer la contraseña. Siempre responde lo mismo (exista o no el correo),
 * para no revelar qué correos están registrados. Máximo 3 enlaces por hora por cuenta.
 */
rAuth.post('/olvide', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  validar({ email: !emailValido(email) && 'Formato de correo inválido' })
  const generica = { ok: true, mensaje: `Si el correo está registrado, te enviamos un enlace para crear una nueva contraseña. Vence en ${MIN_VIGENCIA_ENLACE} minutos.` }
  const u = await one("SELECT id_usuario, nombre, email, estado FROM usuarios WHERE email = ?", [email])
  if (!u || u.estado === 'Inactivo') return res.json(generica)
  const recientes = await one(`SELECT COUNT(*) AS n FROM restablecimientos_contrasena WHERE id_usuario = ? AND fecha_solicitud >= DATEADD(HOUR, -1, ${AHORA})`, [u.id_usuario])
  if (recientes.n >= MAX_ENLACES_HORA) return res.json(generica)

  const token = crypto.randomBytes(32).toString('base64url')
  await transaction(async (cx) => {
    // Pedir un enlace nuevo invalida los anteriores
    await exec(`UPDATE restablecimientos_contrasena SET expira = ${AHORA} WHERE id_usuario = ? AND fecha_uso IS NULL AND expira > ${AHORA}`, [u.id_usuario], cx)
    await exec(`INSERT INTO restablecimientos_contrasena (id_usuario, token_hash, expira, ip) VALUES (?, ?, DATEADD(MINUTE, ?, ${AHORA}), ?)`,
      [u.id_usuario, hashToken(token), MIN_VIGENCIA_ENLACE, String(req.ip || '').slice(0, 45) || null], cx)
    await auditar(req, 'Solicitud de restablecimiento de contraseña', 'usuarios', u.id_usuario, null, null, cx)
  })
  const enlace = `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/restablecer?token=${token}`
  const texto = `Hola, ${u.nombre}:\n\nRecibimos una solicitud para restablecer la contraseña de tu cuenta en Directorio Servicios.\n`
    + `Crea una nueva aquí (el enlace vence en ${MIN_VIGENCIA_ENLACE} minutos y solo se puede usar una vez):\n\n${enlace}\n\n`
    + 'Si no fuiste tú, ignora este correo: tu contraseña actual sigue funcionando.\n\nDirectorio Servicios, SRL · (849) 880-2724'
  let enviado = false
  try {
    enviado = await enviarCorreo({
      para: u.email, asunto: 'Restablece tu contraseña · Directorio Servicios', texto,
      html: `<p>Hola, ${u.nombre}:</p><p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en <b>Directorio Servicios</b>.</p>`
        + `<p><a href="${enlace}" style="background:#1e6b45;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Crear nueva contraseña</a></p>`
        + `<p style="color:#666;font-size:13px">El enlace vence en ${MIN_VIGENCIA_ENLACE} minutos y solo se puede usar una vez. Si no fuiste tú, ignora este correo.</p>`,
    })
  } catch (e) {
    console.error('[correo]', e.message)
  }
  // Desarrollo sin SMTP: el enlace se devuelve para poder probar (nunca en producción)
  res.json(!enviado && process.env.NODE_ENV !== 'production' ? { ...generica, enlace_dev: enlace } : generica)
})

/** Enlace vigente y sin usar → usuario dueño (o null). */
const enlaceVigente = (token, cx) => one(
  `SELECT r.id_restablecimiento, r.id_usuario, u.nombre, u.email FROM restablecimientos_contrasena r JOIN usuarios u ON u.id_usuario = r.id_usuario
    WHERE r.token_hash = ? AND r.fecha_uso IS NULL AND r.expira > ${AHORA} AND u.estado <> 'Inactivo'`, [hashToken(token)], cx)

rAuth.get('/restablecer/:token', async (req, res) => {
  const r = await enlaceVigente(req.params.token)
  if (!r) throw badRequest('El enlace venció o ya se usó. Pide uno nuevo.')
  const [nombre, dominio] = r.email.split('@')
  res.json({ nombre: r.nombre, email: `${nombre.slice(0, 2)}${'•'.repeat(Math.max(nombre.length - 2, 1))}@${dominio}` })
})

/** Guarda la nueva contraseña, desbloquea la cuenta e invalida el enlace. */
rAuth.post('/restablecer', async (req, res) => {
  const contrasena = String(req.body.contrasena || '')
  validar({ contrasena: !contrasenaValida(contrasena) && 'La contraseña no cumple los requisitos' })
  await transaction(async (cx) => {
    const r = await enlaceVigente(req.body.token, cx)
    if (!r) throw badRequest('El enlace venció o ya se usó. Pide uno nuevo.')
    await exec(`UPDATE restablecimientos_contrasena SET fecha_uso = ${AHORA} WHERE id_restablecimiento = ? AND fecha_uso IS NULL`, [r.id_restablecimiento], cx)
    await exec(`UPDATE restablecimientos_contrasena SET expira = ${AHORA} WHERE id_usuario = ? AND fecha_uso IS NULL`, [r.id_usuario], cx)
    await exec(
      "UPDATE usuarios SET contrasena_hash = ?, estado = IIF(estado = 'Bloqueado', 'Activo', estado), intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
      [await bcrypt.hash(contrasena, 10), r.id_usuario], cx)
    await notificar(r.id_usuario, { tipo: 'Sistema', titulo: 'Tu contraseña se cambió', mensaje: 'Si no fuiste tú, contacta a soporte al (849) 880-2724 de inmediato.', canales: ['App', 'Correo'] }, cx)
    await auditar(req, 'Contraseña restablecida', 'usuarios', r.id_usuario, null, null, cx)
  })
  res.json({ ok: true })
})

// ADM-P01 · Registro de cliente (usuarios + clientes en una transacción)
rAuth.post('/registro', async (req, res) => {
  const b = req.body
  const email = String(b.email || '').trim().toLowerCase()
  const empresa = b.tipo_cliente === 'Empresa'
  const doc = soloDigitos(b.rnc_cedula)
  validar({
    nombre: !nombreValido(b.nombre) && 'Indique el nombre (solo letras)',
    apellido: String(b.apellido || '').trim() && !nombreValido(b.apellido) && 'El apellido solo admite letras',
    rnc_cedula: empresa ? !rncValido(doc) && 'RNC inválido' : doc && !cedulaValida(doc) && 'Cédula inválida',
    razon_social: empresa && !String(b.razon_social || '').trim() && 'Indique la razón social',
    email: !emailValido(email) && 'Formato de correo inválido',
    telefono: b.telefono && !telefonoValido(b.telefono) && 'Teléfono inválido',
    direccion: !String(b.direccion || '').trim() && 'Indique la dirección',
    ciudad: !String(b.ciudad || '').trim() && 'Indique la ciudad',
    contrasena: !contrasenaValida(b.contrasena) && 'La contraseña no cumple los requisitos',
  })
  if (await one('SELECT 1 FROM usuarios WHERE email = ?', [email])) throw conflict('Este correo ya está registrado')
  if (doc && (await one('SELECT 1 FROM clientes WHERE rnc_cedula = ?', [doc]))) throw conflict('Esta cédula/RNC ya está registrada')
  // Empresa: el RNC debe estar inscrito y activo en la DGII; se guarda la razón social oficial
  let razonSocial = String(b.razon_social || '').trim()
  if (empresa) {
    const { consultarContribuyente } = await import('./mod-fac.js')
    const c = await consultarContribuyente(doc)
    if (!c.valido) throw badRequest(c.motivo || 'RNC inválido', { rnc_cedula: c.motivo || 'RNC inválido' }) // el mensaje explica si no está inscrito
    if (c.nombre) razonSocial = c.nombre
  }

  const hash = await bcrypt.hash(b.contrasena, 10)
  const id_usuario = await transaction(async (cx) => {
    const rol = await one("SELECT id_rol FROM roles WHERE nombre_rol = 'Cliente'", [], cx)
    const u = await exec(
      'INSERT INTO usuarios (id_rol, nombre, apellido, email, contrasena_hash, telefono) VALUES (?, ?, ?, ?, ?, ?)',
      [rol.id_rol, b.nombre.trim(), String(b.apellido || '').trim(), email, hash, soloDigitos(b.telefono) || null],
      cx,
    )
    await exec(
      'INSERT INTO clientes (id_usuario, tipo_cliente, rnc_cedula, razon_social, direccion, ciudad) VALUES (?, ?, ?, ?, ?, ?)',
      [u.insertId, empresa ? 'Empresa' : 'Persona física', doc || null, empresa ? razonSocial.slice(0, 150) : null, b.direccion.trim(), b.ciudad.trim()],
      cx,
    )
    return u.insertId
  })
  // TODO: enviar correo de bienvenida y verificación (SMTP)
  const u = await one('SELECT u.*, r.nombre_rol FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE id_usuario = ?', [id_usuario])
  res.status(201).json({ token: firmarToken(u), usuario: await perfil(id_usuario) })
})

// CAT-P03 · Registro de prestador: queda Inactivo y estado_aprobacion = Pendiente
rAuth.post('/registro-prestador', upload.array('documentos', 5), async (req, res) => {
  const b = req.body
  const email = String(b.email || '').trim().toLowerCase()
  const cedula = soloDigitos(b.cedula)
  const tarifa = Number(b.tarifa_hora)
  const servicios = [].concat(b.servicios || []).map(Number).filter(Boolean)
  validar({
    nombre: !nombreValido(b.nombre) && 'Indique el nombre (solo letras)',
    apellido: String(b.apellido || '').trim() && !nombreValido(b.apellido) && 'El apellido solo admite letras',
    cedula: !cedulaValida(cedula) && 'Cédula inválida o ya registrada',
    email: !emailValido(email) && 'Formato de correo inválido',
    telefono: b.telefono && !telefonoValido(b.telefono) && 'Teléfono inválido',
    contrasena: !contrasenaValida(b.contrasena) && 'La contraseña no cumple los requisitos',
    id_categoria: !Number(b.id_categoria) && 'Seleccione la categoría principal',
    especialidad: !String(b.especialidad || '').trim() && 'Indique la especialidad',
    tarifa_hora: b.tarifa_hora && !(tarifa > 0 && tarifa <= 50000) && 'Tarifa fuera de rango',
  })
  if (await one('SELECT 1 FROM usuarios WHERE email = ?', [email])) throw conflict('Este correo ya está registrado')
  if (await one('SELECT 1 FROM empleados WHERE cedula = ?', [cedula])) throw conflict('Cédula inválida o ya registrada')

  const nombresDoc = [].concat(b.nombres_documentos || [])
  const documentos = (req.files || []).map((f, i) => ({ nombre: nombresDoc[i] || f.originalname, url: urlArchivo(f), estado: 'Revisar' }))
  const hash = await bcrypt.hash(b.contrasena, 10)

  await transaction(async (cx) => {
    const rol = await one("SELECT id_rol FROM roles WHERE nombre_rol = 'Empleado'", [], cx)
    const u = await exec(
      "INSERT INTO usuarios (id_rol, nombre, apellido, email, contrasena_hash, telefono, estado) VALUES (?, ?, ?, ?, ?, ?, 'Inactivo')",
      [rol.id_rol, b.nombre.trim(), String(b.apellido || '').trim(), email, hash, soloDigitos(b.telefono) || null],
      cx,
    )
    const e = await exec(
      `INSERT INTO empleados (id_usuario, id_categoria, cedula, especialidad, tarifa_hora, zona_cobertura, anios_experiencia, horario, presentacion, documentos)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.insertId, Number(b.id_categoria), cedula, b.especialidad.trim(), tarifa || null, String(b.zona_cobertura || '').slice(0, 500) || null,
        Number(b.anios_experiencia) || null, b.horario || null, String(b.presentacion || '').slice(0, 500) || null, JSON.stringify(documentos)],
      cx,
    )
    for (const s of new Set(servicios)) await exec('INSERT INTO empleado_servicio (id_empleado, id_servicio) VALUES (?, ?)', [e.insertId, s], cx)
    await notificarAdmins({ tipo: 'Sistema', titulo: `${b.nombre.trim()} envió su solicitud de prestador`, mensaje: 'Revise los documentos en Prestadores › Pendientes.' }, cx)
  })
  res.status(201).json({ mensaje: 'Solicitud enviada. Tu perfil quedó Pendiente de aprobación.' })
})

rAuth.get('/me', autenticar, async (req, res) => {
  res.json(await perfil(req.usuario.id_usuario))
})

rAuth.post('/cambiar-contrasena', autenticar, async (req, res) => {
  const { actual, nueva } = req.body
  if (!contrasenaValida(nueva)) throw badRequest('La contraseña no cumple los requisitos')
  const u = await one('SELECT contrasena_hash FROM usuarios WHERE id_usuario = ?', [req.usuario.id_usuario])
  if (!(await bcrypt.compare(String(actual || ''), u.contrasena_hash))) throw badRequest('La contraseña actual no es correcta')
  await exec('UPDATE usuarios SET contrasena_hash = ? WHERE id_usuario = ?', [await bcrypt.hash(nueva, 10), req.usuario.id_usuario])
  await auditar(req, 'Cambio de contraseña', 'usuarios', req.usuario.id_usuario)
  res.json({ ok: true })
})

rAuth.put('/perfil', autenticar, async (req, res) => {
  const b = req.body
  validar({
    telefono: b.telefono && !telefonoValido(b.telefono) && 'Teléfono inválido',
    nombre: b.nombre !== undefined && !nombreValido(b.nombre) && 'El nombre solo admite letras',
    apellido: b.apellido && !nombreValido(b.apellido) && 'El apellido solo admite letras',
  })
  await exec('UPDATE usuarios SET nombre = COALESCE(?, nombre), apellido = COALESCE(?, apellido), telefono = COALESCE(?, telefono) WHERE id_usuario = ?',
    [b.nombre || null, b.apellido ?? null, b.telefono ? soloDigitos(b.telefono) : null, req.usuario.id_usuario])
  if (req.usuario.id_cliente) {
    const empresa = b.tipo_cliente === 'Empresa'
    const doc = b.rnc_cedula !== undefined ? soloDigitos(b.rnc_cedula) : undefined
    if (doc !== undefined) validar({ rnc_cedula: empresa ? !rncValido(doc) && 'RNC inválido' : doc && !cedulaValida(doc) && 'Cédula inválida' })
    await exec(
      `UPDATE clientes SET tipo_cliente = COALESCE(?, tipo_cliente), rnc_cedula = COALESCE(?, rnc_cedula), razon_social = COALESCE(?, razon_social),
              direccion = COALESCE(?, direccion), ciudad = COALESCE(?, ciudad) WHERE id_cliente = ?`,
      [b.tipo_cliente || null, doc || null, b.razon_social || null, b.direccion || null, b.ciudad || null, req.usuario.id_cliente],
    )
  }
  res.json(await perfil(req.usuario.id_usuario))
})

const rAdmin = Router()
rAdmin.use(autenticar, soloRol('Administrador'))

/** Rango de fechas del selector de periodo del dashboard. */
function rango(periodo) {
  return {
    hoy: "CAST(GETDATE() AS date)",
    '7d': "DATEADD(DAY, -6, CAST(GETDATE() AS date))",
    mes: "DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)",
    anio: "DATEFROMPARTS(YEAR(GETDATE()), 1, 1)",
  }[periodo] || "DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)"
}

/** Inicio del periodo anterior equivalente (ayer, los 7 días previos, el mes o el año anterior). */
function rangoAnterior(periodo) {
  return {
    hoy: "DATEADD(DAY, -1, CAST(GETDATE() AS date))",
    '7d': "DATEADD(DAY, -13, CAST(GETDATE() AS date))",
    anio: "DATEFROMPARTS(YEAR(GETDATE()) - 1, 1, 1)",
  }[periodo] || "DATEADD(MONTH, -1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))"
}

// ---------- ADM-P02 · Dashboard ----------
rAdmin.get('/dashboard', async (req, res) => {
  const desde = rango(req.query.periodo)
  const antes = rangoAnterior(req.query.periodo)
  const kpis = await one(
    `SELECT
       (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE estado = 'Confirmado' AND fecha_pago >= ${desde}) AS ingresos,
       (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE estado = 'Confirmado' AND fecha_pago >= ${antes} AND fecha_pago < ${desde}) AS ingresos_anterior,
       (SELECT COUNT(*) FROM solicitudes_servicio WHERE fecha_solicitud >= ${desde}) AS solicitudes_nuevas,
       (SELECT COUNT(*) FROM solicitudes_servicio WHERE fecha_solicitud >= ${antes} AND fecha_solicitud < ${desde}) AS solicitudes_anterior,
       (SELECT COUNT(*) FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario WHERE e.estado_aprobacion = 'Aprobado' AND u.estado = 'Activo') AS prestadores_activos,
       (SELECT COUNT(*) FROM empleados WHERE estado_aprobacion = 'Pendiente') AS prestadores_pendientes,
       (SELECT COUNT(*) FROM ecf WHERE fecha_envio >= ${desde}) AS ecf_emitidos,
       (SELECT COUNT(*) FROM ecf WHERE estado_dgii = 'Rechazado') AS ecf_rechazados,
       (SELECT COUNT(*) FROM ecf WHERE estado_dgii = 'En proceso') AS ecf_en_proceso`)
  const ingresosMes = await query(
    `SELECT FORMAT(m.inicio, 'yyyy-MM') AS mes, COALESCE(SUM(p.monto), 0) AS total
       FROM (SELECT DATEADD(MONTH, -n, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS inicio
               FROM (VALUES (0),(1),(2),(3),(4),(5)) v(n)) m
       LEFT JOIN pagos p ON p.estado = 'Confirmado' AND p.fecha_pago >= m.inicio AND p.fecha_pago < DATEADD(MONTH, 1, m.inicio)
      GROUP BY m.inicio ORDER BY m.inicio`)
  const metodos = await query(
    `SELECT metodo_pago, COUNT(*) AS pagos, SUM(monto) AS monto FROM pagos
      WHERE estado = 'Confirmado' AND fecha_pago >= ${desde} GROUP BY metodo_pago`)
  const porEstado = await query(
    `SELECT estado, COUNT(*) AS n FROM solicitudes_servicio WHERE fecha_solicitud >= ${desde} GROUP BY estado`)
  // Ingresos por servicio: lo facturado (sin ITBIS) en documentos vigentes; así anticipo + saldo no se cuentan doble
  const top = await query(
    `SELECT TOP 5 s.nombre AS servicio, c.nombre AS categoria, x.solicitudes, COALESCE(y.ingresos, 0) AS ingresos
       FROM (SELECT d.id_servicio, COUNT(DISTINCT d.id_solicitud) AS solicitudes
               FROM solicitud_detalle d JOIN solicitudes_servicio so ON so.id_solicitud = d.id_solicitud
              WHERE so.fecha_solicitud >= ${desde} AND d.id_servicio IS NOT NULL GROUP BY d.id_servicio) x
       JOIN servicios s ON s.id_servicio = x.id_servicio JOIN categorias_servicio c ON c.id_categoria = s.id_categoria
       OUTER APPLY (SELECT SUM(fd.cantidad * fd.precio_unitario) AS ingresos FROM factura_detalle fd JOIN facturas f ON f.id_factura = fd.id_factura
                     WHERE fd.id_servicio = x.id_servicio AND f.estado = 'Emitida' AND f.tipo_documento <> 'Nota de crédito'
                       AND f.fecha_emision >= ${desde}) y
      ORDER BY x.solicitudes DESC, ingresos DESC`)
  const alertas = await one(
    `SELECT (SELECT COUNT(*) FROM pagos WHERE estado = 'En verificación') AS pagos_verificacion,
            (SELECT COUNT(*) FROM empleados WHERE estado_aprobacion = 'Pendiente') AS prestadores_pendientes,
            (SELECT COUNT(*) FROM ecf WHERE estado_dgii = 'Rechazado') AS ecf_rechazados,
            (SELECT TOP 1 f.numero_factura FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura WHERE e.estado_dgii = 'Rechazado' ORDER BY e.id_ecf DESC) AS ecf_rechazado_numero,
            (SELECT COUNT(*) FROM solicitudes_nota_credito WHERE estado = 'Pendiente') AS notas_credito_pendientes,
            (SELECT COUNT(*) FROM solicitudes_servicio s WHERE s.estado = 'Pendiente'
                AND NOT EXISTS (SELECT 1 FROM asignaciones_servicio a WHERE a.id_solicitud = s.id_solicitud AND a.estado_asignacion IN ('Asignada','Aceptada'))) AS sin_prestador,
            (SELECT COUNT(*) FROM facturas f WHERE f.estado = 'Emitida' AND NOT EXISTS (SELECT 1 FROM ecf e WHERE e.id_factura = f.id_factura)) AS facturas_sin_encf`)
  res.json({ kpis, ingresos_mes: ingresosMes, metodos, solicitudes_estado: porEstado, top_servicios: top, alertas, generado: new Date().toISOString() })
})

// ---------- ADM-P03 · Aprobación de prestadores ----------
rAdmin.get('/prestadores', async (req, res) => {
  const estado = req.query.estado || 'Pendiente'
  res.json(await query(
    `SELECT e.id_empleado, u.id_usuario, u.nombre, u.apellido, u.email, u.telefono, u.estado AS estado_usuario, e.cedula, e.especialidad,
            e.tarifa_hora, e.zona_cobertura, e.anios_experiencia, e.horario, e.presentacion, e.documentos, e.estado_aprobacion,
            e.calificacion_promedio, e.total_resenas, e.fecha_ingreso, u.fecha_registro, c.nombre AS categoria,
            (SELECT STRING_AGG(s.nombre, ', ') FROM empleado_servicio es JOIN servicios s ON s.id_servicio = es.id_servicio WHERE es.id_empleado = e.id_empleado) AS servicios
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario JOIN categorias_servicio c ON c.id_categoria = e.id_categoria
      WHERE e.estado_aprobacion = ? ORDER BY u.fecha_registro DESC`,
    [estado]).then((rows) => rows.map((x) => ({ ...x, documentos: x.documentos ? JSON.parse(x.documentos) : [] }))))
})

rAdmin.post('/prestadores/:id/decision', async (req, res) => {
  const { decision } = req.body
  const motivo = String(req.body.motivo || '').trim()
  if (!['Aprobar', 'Rechazar', 'Solicitar documento'].includes(decision)) throw badRequest('Decisión inválida')
  if (decision !== 'Aprobar' && !motivo) throw badRequest('Indique el motivo')
  await transaction(async (cx) => {
    const e = await one('SELECT e.*, u.nombre FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario WHERE e.id_empleado = ?', [req.params.id], cx)
    if (!e) throw notFound('Prestador no encontrado')
    if (decision === 'Aprobar') {
      await exec("UPDATE empleados SET estado_aprobacion = 'Aprobado', fecha_ingreso = CAST(GETDATE() AS date) WHERE id_empleado = ?", [e.id_empleado], cx)
      await exec("UPDATE usuarios SET estado = 'Activo' WHERE id_usuario = ?", [e.id_usuario], cx)
    } else if (decision === 'Rechazar') {
      await exec("UPDATE empleados SET estado_aprobacion = 'Rechazado' WHERE id_empleado = ?", [e.id_empleado], cx)
    }
    const titulo = decision === 'Aprobar' ? '¡Tu perfil de prestador fue aprobado!' : decision === 'Rechazar' ? 'Tu solicitud de prestador fue rechazada' : 'Falta un documento en tu solicitud'
    const mensaje = decision === 'Aprobar' ? 'Ya apareces en el catálogo y puedes recibir asignaciones. Inicia sesión para completar tu disponibilidad.' : motivo
    await notificar(e.id_usuario, { tipo: 'Sistema', titulo, mensaje, canales: ['App', 'Correo', 'WhatsApp'] }, cx)
    await auditar(req, `Prestador: ${decision}`, 'empleados', e.id_empleado, { estado_aprobacion: e.estado_aprobacion }, { decision, motivo }, cx)
  })
  res.json({ ok: true })
})

// Estado de cada documento revisado (Verificado / Revisar)
rAdmin.patch('/prestadores/:id/documentos', async (req, res) => {
  if (!Array.isArray(req.body.documentos)) throw badRequest('Lista de documentos inválida')
  await exec('UPDATE empleados SET documentos = ? WHERE id_empleado = ?', [JSON.stringify(req.body.documentos), req.params.id])
  res.json({ ok: true })
})

// Prestadores aprobados (para asignación manual)
rAdmin.get('/prestadores-disponibles', async (req, res) => {
  res.json(await query(
    `SELECT e.id_empleado, CONCAT(u.nombre, ' ', u.apellido) AS nombre, e.especialidad, e.estado_disponibilidad, e.calificacion_promedio, e.zona_cobertura
       FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
      WHERE e.estado_aprobacion = 'Aprobado' AND u.estado = 'Activo' ORDER BY e.calificacion_promedio DESC`))
})

// ---------- ADM-P04 · Usuarios y roles ----------
rAdmin.get('/usuarios', async (req, res) => {
  const q = String(req.query.q || '').trim()
  res.json(await query(
    `SELECT TOP 300 u.id_usuario, COALESCE(c.razon_social, CONCAT(u.nombre, ' ', u.apellido)) AS nombre, u.email, r.nombre_rol AS rol,
            u.ultimo_acceso, u.estado, u.intentos_fallidos
       FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol LEFT JOIN clientes c ON c.id_usuario = u.id_usuario
      ${q ? "WHERE CONCAT(u.nombre, ' ', u.apellido, ' ', u.email, ' ', COALESCE(c.razon_social, '')) LIKE ?" : ''}
      ORDER BY u.id_usuario`,
    q ? [`%${q}%`] : []))
})

// Crea usuarios administrativos
rAdmin.post('/usuarios', async (req, res) => {
  const b = req.body
  const email = String(b.email || '').trim().toLowerCase()
  validar({
    nombre: !nombreValido(b.nombre) && 'Indique el nombre (solo letras)',
    apellido: String(b.apellido || '').trim() && !nombreValido(b.apellido) && 'El apellido solo admite letras',
    email: !emailValido(email) && 'Formato de correo inválido',
    contrasena: !contrasenaValida(b.contrasena) && 'La contraseña no cumple los requisitos',
  })
  if (await one('SELECT 1 AS x FROM usuarios WHERE email = ?', [email])) throw conflict('Este correo ya está registrado')
  const rol = await one("SELECT id_rol FROM roles WHERE nombre_rol = 'Administrador'")
  const x = await exec('INSERT INTO usuarios (id_rol, nombre, apellido, email, contrasena_hash, telefono) VALUES (?, ?, ?, ?, ?, ?)',
    [rol.id_rol, b.nombre.trim(), String(b.apellido || '').trim(), email, await bcrypt.hash(b.contrasena, 10), b.telefono || null])
  await auditar(req, 'Usuario administrativo creado', 'usuarios', x.insertId, null, { email })
  res.status(201).json({ id_usuario: x.insertId })
})

rAdmin.patch('/usuarios/:id', async (req, res) => {
  const u = await one('SELECT u.*, r.nombre_rol FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol WHERE u.id_usuario = ?', [req.params.id])
  if (!u) throw notFound('Usuario no encontrado')
  const { estado } = req.body
  if (!['Activo', 'Inactivo', 'Bloqueado'].includes(estado)) throw badRequest('Estado inválido')
  if (u.id_usuario === req.usuario.id_usuario && estado !== 'Activo') throw conflict('No puede desactivar su propia cuenta')
  // Desbloquear reinicia intentos_fallidos
  await exec(`UPDATE usuarios SET estado = ?, intentos_fallidos = IIF(? = 'Activo', 0, intentos_fallidos), bloqueado_hasta = NULL WHERE id_usuario = ?`,
    [estado, estado, u.id_usuario])
  await auditar(req, `Usuario ${estado}`, 'usuarios', u.id_usuario, { estado: u.estado }, { estado })
  res.json({ ok: true })
})

const PERMISOS_BASE = [
  { p: 'Catálogo (ver)', a: true, e: true, c: true },
  { p: 'Catálogo (crear/editar)', a: true, e: false, c: false },
  { p: 'Solicitudes propias', a: true, e: true, c: true },
  { p: 'Todas las solicitudes', a: true, e: false, c: false },
  { p: 'Aceptar / completar asignación', a: false, e: true, c: false },
  { p: 'Pagar / adjuntar comprobante', a: false, e: false, c: true },
  { p: 'Reportar cobro en efectivo', a: false, e: true, c: false },
  { p: 'Conciliar pagos', a: true, e: false, c: false },
  { p: 'Descargar facturas propias', a: true, e: false, c: true },
  { p: 'Gestionar e-CF y secuencias', a: true, e: false, c: false },
  { p: 'Aprobar prestadores', a: true, e: false, c: false },
  { p: 'Usuarios, roles y reportes', a: true, e: false, c: false },
]

rAdmin.get('/permisos', async (_req, res) => {
  const roles = await query('SELECT id_rol, nombre_rol, permisos FROM roles')
  const admin = roles.find((x) => x.nombre_rol === 'Administrador')
  res.json(admin?.permisos ? JSON.parse(admin.permisos) : PERMISOS_BASE)
})

// La matriz se guarda en roles.permisos; la API sigue aplicando la matriz de la sección 25.2
rAdmin.put('/permisos', async (req, res) => {
  if (!Array.isArray(req.body)) throw badRequest('Matriz inválida')
  const matriz = JSON.stringify(req.body)
  await exec('UPDATE roles SET permisos = ?', [matriz])
  await auditar(req, 'Matriz de permisos actualizada', 'roles', null, null, req.body)
  res.json({ ok: true })
})

// ---------- ADM-P05 · Reportes (sección 31) ----------
const REPORTES = {
  // 31.4 Ingresos por periodo (por categoría)
  ingresos: {
    // Documentos vigentes; las notas de crédito parciales restan (las totales ya anularon su factura)
    sql: `SELECT cat.nombre AS categoria, COUNT(DISTINCT IIF(f.tipo_documento = 'Factura', p.id_pago, NULL)) AS solicitudes_pagadas,
                 SUM(IIF(f.tipo_documento = 'Nota de crédito', -1, 1) * fd.cantidad * fd.precio_unitario) AS subtotal,
                 SUM(IIF(f.tipo_documento = 'Nota de crédito', -1, 1) * fd.itbis_linea) AS itbis,
                 SUM(IIF(f.tipo_documento = 'Nota de crédito', -1, 1) * fd.total_linea) AS total
            FROM facturas f LEFT JOIN facturas fo ON fo.id_factura = f.id_factura_origen
            JOIN pagos p ON p.id_pago = COALESCE(f.id_pago, fo.id_pago) JOIN factura_detalle fd ON fd.id_factura = f.id_factura
            LEFT JOIN servicios s ON s.id_servicio = fd.id_servicio LEFT JOIN categorias_servicio cat ON cat.id_categoria = s.id_categoria
           WHERE f.estado = 'Emitida' AND (f.tipo_documento <> 'Nota de crédito' OR (f.codigo_modificacion = 3 AND f.id_nota_revertida IS NULL))
             AND CAST(f.fecha_emision AS date) BETWEEN ? AND ? {metodo} {categoria}
           GROUP BY cat.nombre ORDER BY total DESC`,
  },
  // Pagos por método
  metodos: {
    sql: `SELECT p.metodo_pago, COUNT(*) AS pagos, SUM(p.monto) AS monto FROM pagos p
           WHERE p.estado = 'Confirmado' AND CAST(p.fecha_pago AS date) BETWEEN ? AND ? {metodo}
           GROUP BY p.metodo_pago ORDER BY monto DESC`,
  },
  // 31.5 Solicitudes por estado
  solicitudes: {
    sql: `SELECT s.estado, COUNT(*) AS cantidad,
                 AVG(CAST(DATEDIFF(MINUTE, s.fecha_solicitud, a.fecha_asignacion) AS FLOAT)) / 60 AS horas_promedio_asignacion,
                 AVG(CAST(DATEDIFF(MINUTE, s.fecha_solicitud, s.fecha_finalizacion) AS FLOAT)) / 60 AS horas_promedio_cierre
            FROM solicitudes_servicio s
            OUTER APPLY (SELECT MIN(fecha_asignacion) AS fecha_asignacion FROM asignaciones_servicio WHERE id_solicitud = s.id_solicitud AND estado_asignacion IN ('Aceptada','Completada')) a
           WHERE CAST(s.fecha_solicitud AS date) BETWEEN ? AND ? GROUP BY s.estado`,
  },
  cancelaciones: {
    sql: `SELECT motivo_cancelacion AS motivo, COUNT(*) AS cantidad FROM solicitudes_servicio
           WHERE estado = 'Cancelado' AND CAST(fecha_solicitud AS date) BETWEEN ? AND ? GROUP BY motivo_cancelacion ORDER BY cantidad DESC`,
  },
  // 31.6 Servicios más solicitados
  servicios: {
    sql: `SELECT s.nombre AS servicio, cat.nombre AS categoria, COUNT(DISTINCT d.id_solicitud) AS solicitudes, SUM(d.subtotal) AS monto_solicitado
            FROM solicitud_detalle d JOIN servicios s ON s.id_servicio = d.id_servicio JOIN categorias_servicio cat ON cat.id_categoria = s.id_categoria
            JOIN solicitudes_servicio so ON so.id_solicitud = d.id_solicitud
           WHERE CAST(so.fecha_solicitud AS date) BETWEEN ? AND ? {categoria} GROUP BY s.nombre, cat.nombre ORDER BY solicitudes DESC`,
  },
  // 31.6 Desempeño de prestadores
  prestadores: {
    sql: `SELECT CONCAT(u.nombre, ' ', u.apellido) AS prestador, e.especialidad,
                 SUM(CASE WHEN a.estado_asignacion = 'Completada' THEN 1 ELSE 0 END) AS completados,
                 SUM(CASE WHEN a.estado_asignacion = 'Rechazada' THEN 1 ELSE 0 END) AS rechazos,
                 e.calificacion_promedio, e.total_resenas
            FROM empleados e JOIN usuarios u ON u.id_usuario = e.id_usuario
            LEFT JOIN asignaciones_servicio a ON a.id_empleado = e.id_empleado AND CAST(a.fecha_asignacion AS date) BETWEEN ? AND ?
           WHERE e.estado_aprobacion = 'Aprobado'
           GROUP BY u.nombre, u.apellido, e.especialidad, e.calificacion_promedio, e.total_resenas ORDER BY completados DESC`,
  },
  // 31.7 Comprobantes e-CF emitidos (607)
  ecf: {
    sql: `SELECT e.ncf, e.tipo_ecf, CONVERT(char(10), f.fecha_emision, 23) AS fecha, c.rnc_cedula, f.subtotal - f.descuento AS monto_facturado,
                 f.itbis, e.estado_dgii
            FROM ecf e JOIN facturas f ON f.id_factura = e.id_factura JOIN clientes c ON c.id_cliente = f.id_cliente
           WHERE CAST(f.fecha_emision AS date) BETWEEN ? AND ? ORDER BY e.ncf`,
  },
  // Uso del asistente IA
  ia: {
    sql: `SELECT COUNT(DISTINCT c.id_conversacion) AS conversaciones,
                 SUM(CASE WHEN m.emisor = 'Cliente' THEN 1 ELSE 0 END) AS preguntas,
                 COALESCE(SUM(m.tokens), 0) AS tokens,
                 (SELECT COUNT(*) FROM ia_sugerencias g WHERE CAST(g.fecha AS date) BETWEEN ? AND ?) AS sugerencias,
                 (SELECT COUNT(*) FROM ia_sugerencias g WHERE g.aceptada = 1 AND CAST(g.fecha AS date) BETWEEN ? AND ?) AS sugerencias_aceptadas
            FROM ia_conversaciones c LEFT JOIN ia_mensajes m ON m.id_conversacion = c.id_conversacion
           WHERE CAST(c.fecha_inicio AS date) BETWEEN ? AND ?`,
    params: 3,
  },
}

rAdmin.get('/reportes/:tipo', async (req, res) => {
  const rep = REPORTES[req.params.tipo]
  if (!rep) throw notFound('Tipo de reporte no existe')
  const desde = req.query.desde || '1900-01-01'
  const hasta = req.query.hasta || '2999-12-31'
  const params = []
  for (let i = 0; i < (rep.params || 1); i++) params.push(desde, hasta)
  let sql = rep.sql
  if (req.query.metodo) { sql = sql.replace('{metodo}', 'AND p.metodo_pago = ?'); params.push(req.query.metodo) } else sql = sql.replace('{metodo}', '')
  if (req.query.categoria) { sql = sql.replace('{categoria}', 'AND cat.nombre = ?'); params.push(req.query.categoria) } else sql = sql.replace('{categoria}', '')
  const filas = await query(sql, params)
  if (req.query.formato === 'csv') {
    const cols = Object.keys(filas[0] || {})
    const esc = (v) => (v === null || v === undefined ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const csv = [cols.join(','), ...filas.map((f) => cols.map((c) => esc(f[c] instanceof Date ? f[c].toISOString() : f[c])).join(','))].join('\r\n')
    return res.type('text/csv; charset=utf-8').attachment(`reporte_${req.params.tipo}_${desde}_${hasta}.csv`).send(`\uFEFF${csv}`)
  }
  res.json({ tipo: req.params.tipo, desde, hasta, generado_por: `${req.usuario.nombre} ${req.usuario.apellido}`, filas })
})

// ---------- Bitácora ----------
rAdmin.get('/bitacora', async (_req, res) => {
  res.json(await query(
    `SELECT TOP 200 b.*, CONCAT(u.nombre, ' ', u.apellido) AS usuario FROM bitacora b LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario ORDER BY b.id_bitacora DESC`))
})

// Centro de notificaciones del usuario conectado (canal App)
const rNotificaciones = Router()
rNotificaciones.use(autenticar)

rNotificaciones.get('/', async (req, res) => {
  const items = await query(
    `SELECT TOP 30 id_notificacion, tipo, titulo, mensaje, leida, fecha_creacion
       FROM notificaciones WHERE id_usuario = ? AND canal = 'App' ORDER BY id_notificacion DESC`,
    [req.usuario.id_usuario])
  const { n } = await one("SELECT COUNT(*) AS n FROM notificaciones WHERE id_usuario = ? AND canal = 'App' AND leida = 0", [req.usuario.id_usuario])
  res.json({ no_leidas: n, items })
})

rNotificaciones.post('/leer-todas', async (req, res) => {
  await exec("UPDATE notificaciones SET leida = 1 WHERE id_usuario = ? AND leida = 0", [req.usuario.id_usuario])
  res.json({ ok: true })
})

rNotificaciones.post('/:id/leer', async (req, res) => {
  await exec('UPDATE notificaciones SET leida = 1 WHERE id_notificacion = ? AND id_usuario = ?', [req.params.id, req.usuario.id_usuario])
  res.json({ ok: true })
})

// ---------- Rutas del módulo (montadas en /api) ----------
export const router = Router()
// ---------- Contadores del menú: cosas pendientes de atender según el rol ----------
const rMenu = Router()
rMenu.get('/contadores', autenticar, async (req, res) => {
  const u = req.usuario
  if (u.nombre_rol === 'Cliente') {
    // Solicitudes que esperan algo del cliente: pagar, confirmar la finalización o responder un cargo adicional
    const activas = await query(
      `SELECT s.id_solicitud, s.estado,
              (SELECT TOP 1 a.estado_asignacion FROM asignaciones_servicio a WHERE a.id_solicitud = s.id_solicitud
                ORDER BY IIF(a.estado_asignacion = 'Rechazada', 1, 0), a.id_asignacion DESC) AS estado_asignacion
         FROM solicitudes_servicio s WHERE s.id_cliente = ? AND s.estado IN ('En proceso', 'Completado')`, [u.id_cliente])
    let pendientes = 0
    for (const s of activas) {
      const cobro = await estadoCobro(s.id_solicitud)
      const confirmar = s.estado === 'En proceso' && s.estado_asignacion === 'Completada'
      if (cobro.siguiente || confirmar || cobro.cargos.some((c) => c.estado === 'Pendiente')) pendientes++
    }
    return res.json({ '/mis-solicitudes': pendientes })
  }
  if (u.nombre_rol === 'Empleado') {
    const r = await one("SELECT COUNT(*) AS n FROM asignaciones_servicio WHERE id_empleado = ? AND estado_asignacion = 'Asignada'", [u.id_empleado])
    return res.json({ '/prestador/asignaciones': r.n })
  }
  const r = await one(
    `SELECT (SELECT COUNT(*) FROM empleados WHERE estado_aprobacion = 'Pendiente') AS prestadores,
            (SELECT COUNT(*) FROM pagos WHERE estado = 'En verificación') AS pagos,
            (SELECT COUNT(*) FROM solicitudes_nota_credito WHERE estado = 'Pendiente')
              + (SELECT COUNT(*) FROM ecf WHERE estado_dgii = 'Rechazado')
              + (SELECT COUNT(*) FROM facturas f WHERE f.estado = 'Emitida' AND NOT EXISTS (SELECT 1 FROM ecf e WHERE e.id_factura = f.id_factura)) AS facturacion,
            (SELECT COUNT(*) FROM solicitudes_servicio s WHERE s.estado = 'Pendiente'
               AND NOT EXISTS (SELECT 1 FROM asignaciones_servicio a WHERE a.id_solicitud = s.id_solicitud AND a.estado_asignacion IN ('Asignada', 'Aceptada'))) AS sin_asignar`)
  res.json({ '/admin/prestadores': r.prestadores, '/admin/pagos': r.pagos, '/admin/facturacion': r.facturacion, '/admin/solicitudes': r.sin_asignar })
})

router.use('/menu', rMenu)
router.use('/auth', rAuth)
router.use('/notificaciones', rNotificaciones)
router.use('/admin', rAdmin)
