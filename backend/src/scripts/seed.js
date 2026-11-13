// Datos iniciales de demostración. Idempotente: solo inserta lo que no existe.
// Contraseña de todos los usuarios demo: Demo1234
import bcrypt from 'bcryptjs'
import { exec, getPool, one, query } from '../config/db.js'

const CLAVE = 'Demo1234'
const hash = await bcrypt.hash(CLAVE, 10)
const rol = async (n) => (await one('SELECT id_rol FROM roles WHERE nombre_rol = ?', [n])).id_rol
const cat = async (n) => (await one('SELECT id_categoria FROM categorias_servicio WHERE nombre = ?', [n])).id_categoria

// ---------- Catálogo ----------
const ICONOS = {
  'Reparación eléctrica residencial': '💡', 'Mantenimiento de aire acondicionado': '❄️', 'Soporte técnico de computadoras': '🖥️',
  'Consulta legal (contratos)': '⚖️', 'Declaración de impuestos (IR-1/IT-1)': '📊', 'Limpieza profunda del hogar': '🧹', 'Fumigación residencial': '🐜',
}
for (const [nombre, icono] of Object.entries(ICONOS)) await exec('UPDATE servicios SET icono = ? WHERE nombre = ? AND icono IS NULL', [icono, nombre])

const SERVICIOS = [
  ['Técnicos', 'Instalación de lámparas / abanicos', 'Instalación de lámparas, abanicos de techo y apliques.', 900, 60, 'En sitio', 'Publicado', '💡'],
  ['Técnicos', 'Cambio de panel de breakers', 'Sustitución del panel eléctrico y breakers.', 6500, 240, 'En sitio', 'Publicado', '⚡'],
  ['Técnicos', 'Diagnóstico eléctrico', 'Revisión de cortocircuitos y fallas eléctricas.', 800, 60, 'En sitio', 'Publicado', '🔌'],
  ['Profesionales', 'Consulta contable mensual', 'Asesoría contable y cumplimiento fiscal mensual.', 3000, 60, 'Remoto', 'Publicado', '🧾'],
  ['Profesionales', 'Diseño arquitectónico (planos)', 'Diseño y planos arquitectónicos residenciales.', 8000, 180, 'Ambas', 'Publicado', '📐'],
  ['Hogar', 'Instalación de calentadores', 'Instalación de calentadores de agua eléctricos o de gas.', 2500, 120, 'En sitio', 'Publicado', '🚿'],
  ['Hogar', 'Plomería – destape', 'Destape de tuberías, fregaderos e inodoros.', 1300, 60, 'En sitio', 'Inactivo', '🚰'],
]
for (const [c, nombre, desc, precio, dur, mod, estado, icono] of SERVICIOS) {
  if (!(await one('SELECT 1 AS x FROM servicios WHERE nombre = ?', [nombre]))) {
    await exec('INSERT INTO servicios (id_categoria, nombre, descripcion, precio_base, duracion_estimada, modalidad, aplica_itbis, estado, icono) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [await cat(c), nombre, desc, precio, dur, mod, estado, icono])
  }
}
const srv = async (n) => (await one('SELECT id_servicio FROM servicios WHERE nombre = ?', [n])).id_servicio

// ---------- Secuencias e-NCF autorizadas ----------
if (!(await one('SELECT 1 AS x FROM secuencias_ecf'))) {
  await exec("INSERT INTO secuencias_ecf (tipo_ecf, desde, hasta, ultimo_usado, vencimiento) VALUES ('e31', 1, 500, 0, '2027-12-31'), ('e32', 1, 2000, 0, '2027-12-31')")
}

// ---------- Usuarios ----------
async function usuario({ rol: r, nombre, apellido = '', email, telefono = null, estado = 'Activo' }) {
  const u = await one('SELECT id_usuario FROM usuarios WHERE email = ?', [email])
  if (u) return { id: u.id_usuario, nuevo: false }
  const x = await exec('INSERT INTO usuarios (id_rol, nombre, apellido, email, contrasena_hash, telefono, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [await rol(r), nombre, apellido, email, hash, telefono, estado])
  return { id: x.insertId, nuevo: true }
}

await usuario({ rol: 'Administrador', nombre: 'Ana', apellido: 'Díaz', email: 'ana.diaz@directorioservicios.do', telefono: '8098802724' })

const CLIENTES = [
  { nombre: 'María Altagracia', apellido: 'Rodríguez Peña', email: 'maria.rodriguez@gmail.com', telefono: '8095550142', tipo: 'Persona física', doc: '40212345678', dir: 'C/ José Amado Soler #45, Apto 3B, Piantini', ciudad: 'Santo Domingo, D.N.' },
  { nombre: 'Textiles Caribe', apellido: 'SRL', email: 'compras@textilescaribe.do', telefono: '8095550188', tipo: 'Empresa', doc: '132456785', razon: 'Textiles Caribe SRL', dir: 'Av. Tiradentes #22, Naco', ciudad: 'Santo Domingo, D.N.' },
  { nombre: 'Pedro', apellido: 'Guzmán', email: 'pedro.guzman@gmail.com', telefono: '8295550120', tipo: 'Persona física', doc: null, dir: 'C/ Pedro Henríquez Ureña #80, Gazcue', ciudad: 'Santo Domingo, D.N.' },
]
for (const c of CLIENTES) {
  const u = await usuario({ rol: 'Cliente', ...c })
  if (u.nuevo) {
    await exec('INSERT INTO clientes (id_usuario, tipo_cliente, rnc_cedula, razon_social, direccion, ciudad) VALUES (?, ?, ?, ?, ?, ?)',
      [u.id, c.tipo, c.doc, c.razon || null, c.dir, c.ciudad])
  }
}

const PRESTADORES = [
  { nombre: 'Carlos', apellido: 'Méndez', email: 'cmendez.electric@gmail.com', cat: 'Técnicos', cedula: '00176543210', esp: 'Electricista residencial y comercial', tarifa: 900, zona: 'Piantini, Naco, Bella Vista, Gazcue', anios: 9, cal: 4.8, res: 126,
    servicios: ['Reparación eléctrica residencial', 'Instalación de lámparas / abanicos', 'Cambio de panel de breakers', 'Diagnóstico eléctrico'],
    pres: 'Instalaciones y reparaciones eléctricas, cambio de breakers, cableado, lámparas, tomas 110/220 V y diagnóstico de cortocircuitos. Trabajo con garantía de 30 días.' },
  { nombre: 'José', apellido: 'Ramírez', email: 'jose.ramirez.aa@gmail.com', cat: 'Técnicos', cedula: '00198765432', esp: 'Técnico de A/A', tarifa: 1100, zona: 'Naco, Evaristo Morales, Piantini', anios: 6, cal: 4.7, res: 64,
    servicios: ['Mantenimiento de aire acondicionado'] },
  { nombre: 'Julio', apellido: 'Peralta', email: 'julio.peralta@gmail.com', cat: 'Técnicos', cedula: '00122334455', esp: 'Técnico en computadoras', tarifa: 800, zona: 'Piantini, Bella Vista, Gazcue, Los Prados', anios: 5, cal: 4.6, res: 41,
    servicios: ['Soporte técnico de computadoras', 'Reparación eléctrica residencial'] },
  { nombre: 'Luisa', apellido: 'Peña', email: 'luisa.pena.cpa@gmail.com', cat: 'Profesionales', cedula: '00133445566', esp: 'Lic. en Contabilidad', tarifa: 1500, zona: 'Santo Domingo', anios: 7, cal: 4.9, res: 88,
    servicios: ['Declaración de impuestos (IR-1/IT-1)', 'Consulta contable mensual'] },
  { nombre: 'Patricia', apellido: 'Almonte', email: 'palmonte.legal@gmail.com', cat: 'Profesionales', cedula: '00144556677', esp: 'Abogada corporativa', tarifa: 2500, zona: 'Santo Domingo', anios: 10, cal: 4.9, res: 33,
    servicios: ['Consulta legal (contratos)'] },
  { nombre: 'Rosa', apellido: 'Almánzar', email: 'rosa.almanzar@gmail.com', cat: 'Hogar', cedula: '00155667788', esp: 'Limpieza profunda residencial', tarifa: 600, zona: 'Piantini, Naco, Gazcue, Bella Vista, Evaristo Morales', anios: 8, cal: 4.8, res: 47,
    servicios: ['Limpieza profunda del hogar', 'Instalación de calentadores'] },
  // Pendientes de aprobación (ADM-P03)
  { nombre: 'Ramón', apellido: 'Féliz', email: 'ramonfeliz.plom@gmail.com', cat: 'Hogar', cedula: '00176543211', esp: 'Plomería residencial', tarifa: 800, zona: 'Los Mina, Alma Rosa, Ensanche Ozama', anios: 6, pendiente: true,
    servicios: ['Plomería – destape', 'Instalación de calentadores'], docs: ['Cédula (frente y reverso)', 'Certificado INFOTEP – Plomería', 'Certificado de buena conducta'] },
  { nombre: 'Yesenia', apellido: 'Castillo', email: 'yesenia.castillo@gmail.com', cat: 'Hogar', cedula: '40222334451', esp: 'Limpieza profunda residencial', tarifa: 600, zona: 'Herrera, Las Caobas', anios: 4, pendiente: true,
    servicios: ['Limpieza profunda del hogar'], docs: ['Cédula (frente y reverso)', 'Certificado de buena conducta'] },
  { nombre: 'Andrés', apellido: 'Matos', email: 'arq.andresmatos@gmail.com', cat: 'Profesionales', cedula: '00111223345', esp: 'Arquitectura y diseño de planos', tarifa: 2500, zona: 'Distrito Nacional, Santo Domingo Norte', anios: 11, pendiente: true,
    servicios: ['Diseño arquitectónico (planos)'], docs: ['Cédula (frente y reverso)', 'Título universitario – Arquitectura', 'Certificado de buena conducta'] },
]
for (const p of PRESTADORES) {
  const u = await usuario({ rol: 'Empleado', ...p, estado: p.pendiente ? 'Inactivo' : 'Activo' })
  if (!u.nuevo) continue
  const docs = (p.docs || ['Cédula (frente y reverso)', 'Certificado técnico / título', 'Certificado de buena conducta'])
    .map((n, i) => ({ nombre: n, url: null, estado: p.pendiente && i === p.docs.length - 1 ? 'Revisar' : 'Verificado' }))
  const e = await exec(
    `INSERT INTO empleados (id_usuario, id_categoria, cedula, especialidad, tarifa_hora, zona_cobertura, calificacion_promedio, total_resenas,
                            estado_aprobacion, anios_experiencia, horario, presentacion, documentos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.id, await cat(p.cat), p.cedula, p.esp, p.tarifa, p.zona, p.cal || 0, p.res || 0, p.pendiente ? 'Pendiente' : 'Aprobado',
      p.anios, 'Lunes a sábado · 8:00 a. m. – 6:00 p. m.', p.pres || null, JSON.stringify(docs)])
  for (const s of p.servicios) await exec('INSERT INTO empleado_servicio (id_empleado, id_servicio) VALUES (?, ?)', [e.insertId, await srv(s)])
}

// ---------- Suscripción demo: María con plan Hogar+ ----------
const maria = await one("SELECT c.id_cliente FROM clientes c JOIN usuarios u ON u.id_usuario = c.id_usuario WHERE u.email = 'maria.rodriguez@gmail.com'")
const hogar = await one("SELECT id_plan FROM planes WHERE nombre = 'Hogar+'")
if (maria && hogar && !(await one('SELECT 1 AS x FROM suscripciones WHERE id_cliente = ?', [maria.id_cliente]))) {
  await exec("INSERT INTO suscripciones (id_cliente, id_plan, fecha_inicio, fecha_renovacion, paypal_subscription_id, estado) VALUES (?, ?, DATEADD(DAY, -20, CAST(GETDATE() AS date)), DATEADD(DAY, 10, CAST(GETDATE() AS date)), 'I-8KX29PL3', 'Activa')",
    [maria.id_cliente, hogar.id_plan])
}

const resumen = await query(`SELECT r.nombre_rol AS rol, COUNT(*) AS usuarios FROM usuarios u JOIN roles r ON r.id_rol = u.id_rol GROUP BY r.nombre_rol`)
console.table(resumen)
console.log(`Datos de demostración listos. Contraseña de todos los usuarios: ${CLAVE}`)
await (await getPool()).close()
