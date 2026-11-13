// Datos de ejemplo para el diseño de pantallas. Se reemplazarán por la API cuando se construya el backend.

export const categorias = [
  { id: 1, nombre: 'Técnicos', icono: '🔧', total: 24 },
  { id: 2, nombre: 'Profesionales', icono: '💼', total: 15 },
  { id: 3, nombre: 'Hogar', icono: '🏠', total: 18 },
]

export const servicios = [
  { id: 1, codigo: 'SRV-001', cat: 'Técnicos', nombre: 'Reparación eléctrica residencial', modalidad: 'En sitio', precio: 1500, duracion: 120, itbis: true, estado: 'Publicado', icono: '💡', rating: 4.8, prestadores: 12 },
  { id: 2, codigo: 'SRV-002', cat: 'Técnicos', nombre: 'Mantenimiento de aire acondicionado', corto: 'Mantenimiento de A/A', modalidad: 'En sitio', precio: 2200, duracion: 90, itbis: true, estado: 'Publicado', icono: '❄️', rating: 4.7, prestadores: 19 },
  { id: 3, codigo: 'SRV-003', cat: 'Técnicos', nombre: 'Soporte técnico de computadoras', corto: 'Soporte técnico PC', modalidad: 'Ambas', precio: 1200, duracion: 60, itbis: true, estado: 'Publicado', icono: '🖥️', rating: 4.9, prestadores: 26 },
  { id: 14, codigo: 'SRV-014', cat: 'Profesionales', nombre: 'Consulta legal (contratos)', modalidad: 'Ambas', precio: 3500, duracion: 60, itbis: true, estado: 'Publicado', icono: '⚖️', rating: 4.9, prestadores: 33 },
  { id: 15, codigo: 'SRV-015', cat: 'Profesionales', nombre: 'Declaración de impuestos (IR-1/IT-1)', corto: 'Declaración IR-1 / IT-1', modalidad: 'Remoto', precio: 4000, duracion: 120, itbis: true, estado: 'Publicado', icono: '📊', rating: 4.6, prestadores: 40 },
  { id: 31, codigo: 'SRV-031', cat: 'Hogar', nombre: 'Limpieza profunda del hogar', modalidad: 'En sitio', precio: 2800, duracion: 240, itbis: true, estado: 'Publicado', icono: '🧹', rating: 4.8, prestadores: 47 },
  { id: 32, codigo: 'SRV-032', cat: 'Hogar', nombre: 'Fumigación residencial', modalidad: 'En sitio', precio: 3200, duracion: 120, itbis: true, estado: 'Borrador', icono: '🐜', rating: 0, prestadores: 0 },
  { id: 33, codigo: 'SRV-033', cat: 'Hogar', nombre: 'Plomería – destape', modalidad: 'En sitio', precio: 1300, duracion: 60, itbis: true, estado: 'Inactivo', icono: '🚰', rating: 4.5, prestadores: 8 },
]

export function modalidadLabel(s) {
  if (s.cat === 'Profesionales') return { 'En sitio': 'Presencial', Remoto: 'Virtual', Ambas: 'Presencial / Virtual' }[s.modalidad]
  return { 'En sitio': 'En sitio', Remoto: 'Remoto', Ambas: 'Sitio / Remoto' }[s.modalidad]
}

export const prestadores = [
  {
    id: 1, slug: 'carlos-mendez', nombre: 'Carlos Méndez', ini: 'CM', especialidad: 'Electricista residencial y comercial', corto: 'Electricista',
    anios: 9, rating: 4.8, resenas: 126, tarifa: 900, zonas: ['Piantini', 'Naco', 'Bella Vista', 'Gazcue'], disponible: true,
    bio: 'Instalaciones y reparaciones eléctricas, cambio de breakers, cableado, lámparas, tomas 110/220 V y diagnóstico de cortocircuitos. Trabajo con garantía de 30 días.',
    servicios: [
      { nombre: 'Reparación eléctrica residencial', modalidad: 'En sitio', duracion: '2 h', precio: 1500 },
      { nombre: 'Instalación de lámparas / abanicos', modalidad: 'En sitio', duracion: '1 h', precio: 900 },
      { nombre: 'Cambio de panel de breakers', modalidad: 'En sitio', duracion: '4 h', precio: 6500 },
      { nombre: 'Diagnóstico eléctrico', modalidad: 'En sitio', duracion: '1 h', precio: 800 },
    ],
  },
  { id: 2, slug: 'luisa-pena', nombre: 'Luisa Peña', ini: 'LP', especialidad: 'Lic. en Contabilidad', corto: 'Lic. en Contabilidad', anios: 7, rating: 4.9, resenas: 88, tarifa: 1500, zonas: ['Santo Domingo, D.N.'], disponible: true },
  { id: 3, slug: 'jose-ramirez', nombre: 'José Ramírez', ini: 'JR', especialidad: 'Técnico de A/A', corto: 'Técnico de A/A', anios: 6, rating: 4.7, resenas: 64, tarifa: 1100, zonas: ['Naco', 'Evaristo Morales'], disponible: true },
  { id: 4, slug: 'ramon-feliz', nombre: 'Ramón Féliz', ini: 'RF', especialidad: 'Electricista', corto: 'Electricista', anios: 6, rating: 4.6, resenas: 41, tarifa: 800, zonas: ['Piantini'], disponible: true },
]

export const resenas = [
  { autor: 'Pedro G.', estrellas: 5, cuando: 'hace 3 días', texto: 'Llegó puntual, resolvió el cortocircuito de la cocina en una hora. Muy recomendado.' },
  { autor: 'Empresa Textiles Caribe', estrellas: 5, cuando: 'hace 2 semanas', texto: 'Excelente trabajo en el cableado de la oficina, factura con crédito fiscal sin problemas.' },
  { autor: 'Rosa M.', estrellas: 4, cuando: 'hace 1 mes', texto: 'Buen servicio, se demoró un poco en llegar.' },
]

export const misSolicitudes = [
  { codigo: 'SOL-2K7Q9X', servicio: 'Reparación eléctrica residencial', prestador: 'Carlos Méndez', fecha: '06/10/2026', total: 1770, estado: 'En proceso', pago: null },
  { codigo: 'SOL-9PL2AA', servicio: 'Limpieza profunda del hogar', prestador: 'Asignación automática', fecha: '09/10/2026', total: 3304, estado: 'Pendiente', pago: null },
  { codigo: 'SOL-7TQ1MB', servicio: 'Mantenimiento de A/A', prestador: 'José Ramírez', fecha: '21/09/2026', total: 2596, estado: 'Completado', pago: 'Confirmado' },
  { codigo: 'SOL-5RZ8KD', servicio: 'Declaración IR-1', prestador: 'Luisa Peña', fecha: '10/09/2026', total: 4720, estado: 'Completado', pago: 'En verificación' },
  { codigo: 'SOL-3HC6WE', servicio: 'Fumigación residencial', prestador: '—', fecha: '28/08/2026', total: 3776, estado: 'Cancelado', pago: null },
]

export const notificacionesCliente = [
  { icono: '🛠️', titulo: 'Carlos Méndez aceptó tu solicitud SOL-2K7Q9X', cuando: 'hace 2 días', nueva: true },
  { icono: '📄', titulo: 'Tu factura E320000000123 está disponible', cuando: 'hace 5 días', nueva: true },
  { icono: '⏳', titulo: 'Tu transferencia de SOL-5RZ8KD está en verificación', cuando: 'hace 1 semana', nueva: true },
  { icono: '⭐', titulo: 'Califica tu servicio de Mantenimiento de A/A', cuando: 'hace 2 semanas', nueva: false },
]

export const notificacionesAdmin = [
  { icono: '⏳', titulo: '4 pagos en verificación esperan conciliación', cuando: 'hace 20 min', nueva: true },
  { icono: '🧰', titulo: 'Ramón Féliz envió su solicitud de prestador', cuando: 'hace 2 h', nueva: true },
  { icono: '📄', titulo: 'e-CF E310000000086 rechazado por la DGII', cuando: 'hace 3 h', nueva: true },
  { icono: '⚡', titulo: '2 solicitudes sin prestador disponible', cuando: 'hace 5 h', nueva: true },
]

export const notificacionesPrestador = [
  { icono: '🗂️', titulo: 'Nueva asignación SOL-9PL2AA · Instalación de lámparas', cuando: 'hace 18 min', nueva: true },
  { icono: '⭐', titulo: 'María Rodríguez te calificó con 5 estrellas', cuando: 'hace 1 día', nueva: false },
]

export const pagosVerificacion = [
  { id: 'PAG-1039', sol: 'SOL-5RZ8KD', cliente: 'María Rodríguez', metodo: 'Transferencia', ref: 'TRF-88231457', monto: 4720, fecha: '06/10' },
  { id: 'PAG-1041', sol: 'SOL-4FD7NN', cliente: 'Textiles Caribe SRL', metodo: 'Transferencia', ref: 'BHD-772910', monto: 2124, fecha: '06/10' },
  { id: 'PAG-1043', sol: 'SOL-8BQ3L5', cliente: 'Rosa Martínez', metodo: 'Efectivo', ref: 'REC-000482', monto: 3186, fecha: '06/10' },
  { id: 'PAG-1044', sol: 'SOL-6MN2PQ', cliente: 'Pedro Guzmán', metodo: 'Efectivo', ref: 'REC-000119', monto: 3481, fecha: '05/10' },
]

export const comprobantes = [
  { ncf: 'E320000000124', factura: 'FAC-001042', cliente: 'María Rodríguez', doc: '40212345678', itbis: 351, total: 2301, track: '8f2c...a91e', estado: 'Aceptado' },
  { ncf: 'E310000000087', factura: 'FAC-001041', cliente: 'Textiles Caribe SRL', doc: '132456789', itbis: 324, total: 2124, track: '1b77...c03d', estado: 'Aceptado' },
  { ncf: 'E320000000123', factura: 'FAC-001040', cliente: 'Pedro Guzmán', doc: '00112345671', itbis: 531, total: 3481, track: 'e90a...77f2', estado: 'En proceso' },
  { ncf: 'E310000000086', factura: 'FAC-001039', cliente: 'Inversiones Lara SRL', doc: '101234567', itbis: 612, total: 4012, track: '44cd...1a20', estado: 'Rechazado' },
  { ncf: 'E320000000122', factura: 'FAC-001038', cliente: 'Rosa Martínez', doc: '22398765432', itbis: 486, total: 3186, track: '7a1o...903c', estado: 'Aceptado condicional' },
]

export const secuencias = [
  { tipo: 'e31', nombre: 'Crédito Fiscal', desde: 'E310000000001', hasta: 'E310000000500', ultimo: 'E310000000087', disponibles: 413, total: 500, venc: '31/12/2027' },
  { tipo: 'e32', nombre: 'Consumo', desde: 'E320000000001', hasta: 'E320000002000', ultimo: 'E320000000124', disponibles: 1876, total: 2000, venc: '31/12/2027' },
]

export const serviciosTop = [
  { servicio: 'Limpieza profunda del hogar', cat: 'Hogar', solicitudes: 48, ingresos: 158592 },
  { servicio: 'Reparación eléctrica residencial', cat: 'Técnicos', solicitudes: 41, ingresos: 88560 },
  { servicio: 'Mantenimiento de A/A', cat: 'Técnicos', solicitudes: 33, ingresos: 85668 },
  { servicio: 'Declaración IR-1 / IT-1', cat: 'Profesionales', solicitudes: 21, ingresos: 99120 },
  { servicio: 'Soporte técnico PC', cat: 'Técnicos', solicitudes: 19, ingresos: 26904 },
]

export const ingresosMes = [
  { mes: 'May', v: 217 }, { mes: 'Jun', v: 248 }, { mes: 'Jul', v: 280 },
  { mes: 'Ago', v: 322 }, { mes: 'Sep', v: 364 }, { mes: 'Oct', v: 413 },
]

export const solicitudesEstado = [
  { estado: 'Pendiente', n: 28, color: '#f0a63a' },
  { estado: 'En proceso', n: 43, color: '#3b82f6' },
  { estado: 'Completado', n: 146, color: '#1b5e3a' },
  { estado: 'Cancelado', n: 19, color: '#d63b3b' },
]

export const solicitantes = [
  {
    id: 1, nombre: 'Ramón Féliz', ini: 'RF', cat: 'Técnicos', esp: 'Plomero', cuando: 'hace 2 h', anios: 6, zona: 'Santo Domingo Este',
    especialidadLarga: 'Plomería residencial', cedula: '001-7654321-0', servicios: 'Plomería – destape, Instalación de calentadores',
    tarifa: 'RD$ 800 / hora', zonas: 'Los Mina, Alma Rosa, Ensanche Ozama', telefono: '829-555-0177',
    docs: [
      { nombre: 'Cédula (frente y reverso)', estado: 'Verificado' },
      { nombre: 'Certificado INFOTEP – Plomería', estado: 'Verificado' },
      { nombre: 'Certificado de buena conducta', estado: 'Revisar' },
    ],
  },
  {
    id: 2, nombre: 'Yesenia Castillo', ini: 'YC', cat: 'Hogar', esp: 'Limpieza', cuando: 'hace 1 día', anios: 4, zona: 'Santo Domingo Oeste',
    especialidadLarga: 'Limpieza profunda residencial', cedula: '402-2233445-1', servicios: 'Limpieza profunda del hogar',
    tarifa: 'RD$ 600 / hora', zonas: 'Herrera, Las Caobas', telefono: '809-555-0143',
    docs: [
      { nombre: 'Cédula (frente y reverso)', estado: 'Verificado' },
      { nombre: 'Certificado de buena conducta', estado: 'Revisar' },
    ],
  },
  {
    id: 3, nombre: 'Arq. Andrés Matos', ini: 'AM', cat: 'Profesionales', esp: 'Arquitectura', cuando: 'hace 2 días', anios: 11, zona: 'Distrito Nacional',
    especialidadLarga: 'Arquitectura y diseño de planos', cedula: '001-1122334-5', servicios: 'Diseño arquitectónico (planos)',
    tarifa: 'RD$ 2,500 / hora', zonas: 'Distrito Nacional, Santo Domingo Norte', telefono: '849-555-0190',
    docs: [
      { nombre: 'Cédula (frente y reverso)', estado: 'Verificado' },
      { nombre: 'Título universitario – Arquitectura', estado: 'Revisar' },
      { nombre: 'Certificado de buena conducta', estado: 'Revisar' },
    ],
  },
]

export const usuarios = [
  { nombre: 'Ana Díaz', correo: 'ana.diaz@directorioservicios.do', rol: 'Administrador', acceso: '06/10 1:02 p. m.', estado: 'Activo' },
  { nombre: 'Carlos Méndez', correo: 'cmendez.electric@gmail.com', rol: 'Empleado', acceso: '06/10 12:40 p. m.', estado: 'Activo' },
  { nombre: 'María Rodríguez', correo: 'maria.rodriguez@gmail.com', rol: 'Cliente', acceso: '06/10 12:41 p. m.', estado: 'Activo' },
  { nombre: 'Ramón Féliz', correo: 'ramonfeliz.plom@gmail.com', rol: 'Empleado', acceso: '—', estado: 'Inactivo' },
  { nombre: 'Textiles Caribe SRL', correo: 'compras@textilescaribe.do', rol: 'Cliente', acceso: '05/10 4:15 p. m.', estado: 'Activo' },
  { nombre: 'Luis Batista', correo: 'lbatista@hotmail.com', rol: 'Cliente', acceso: '01/10 9:20 a. m.', estado: 'Bloqueado' },
]

export const permisos = [
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

export const reporteIngresos = {
  categorias: [
    { cat: 'Servicios técnicos', n: 118, sub: 152840, itbis: 27511.2, total: 180351.2, pct: '49.2%' },
    { cat: 'Servicios profesionales', n: 41, sub: 98300, itbis: 17694, total: 115994, pct: '31.6%' },
    { cat: 'Servicios del hogar', n: 54, sub: 59760, itbis: 10756.8, total: 70516.8, pct: '19.2%' },
  ],
  total: { n: 213, sub: 310900, itbis: 55962, total: 366862 },
  metodos: [
    { m: 'PayPal', n: 86, monto: 150413.42 },
    { m: 'Tarjeta (Azul/CardNet)', n: 65, monto: 110058.6 },
    { m: 'Transferencia', n: 36, monto: 62366.54 },
    { m: 'Efectivo', n: 26, monto: 44023.44 },
  ],
}

export const solicitudesAdmin = [
  { codigo: 'SOL-2K7Q9X', cliente: 'María Rodríguez', servicio: 'Reparación eléctrica residencial', prestador: 'Carlos Méndez', fecha: '06/10/2026', total: 1770, estado: 'En proceso' },
  { codigo: 'SOL-9PL2AA', cliente: 'María Rodríguez', servicio: 'Limpieza profunda del hogar', prestador: '—', fecha: '09/10/2026', total: 3304, estado: 'Pendiente' },
  { codigo: 'SOL-4FD7NN', cliente: 'Textiles Caribe SRL', servicio: 'Diagnóstico eléctrico', prestador: 'Carlos Méndez', fecha: '06/10/2026', total: 2124, estado: 'Completado' },
  { codigo: 'SOL-8BQ3L5', cliente: 'Rosa Martínez', servicio: 'Cambio de breakers', prestador: 'Carlos Méndez', fecha: '06/10/2026', total: 3186, estado: 'Completado' },
  { codigo: 'SOL-6MN2PQ', cliente: 'Pedro Guzmán', servicio: 'Limpieza profunda del hogar', prestador: 'Yesenia Castillo', fecha: '05/10/2026', total: 3481, estado: 'Completado' },
  { codigo: 'SOL-1QW8ZT', cliente: 'Juan Pérez', servicio: 'Soporte técnico PC', prestador: '—', fecha: '10/10/2026', total: 1416, estado: 'Pendiente' },
  { codigo: 'SOL-3HC6WE', cliente: 'María Rodríguez', servicio: 'Fumigación residencial', prestador: '—', fecha: '28/08/2026', total: 3776, estado: 'Cancelado' },
]

export const planes = [
  { nombre: 'Básico', precio: 990, items: ['1 diagnóstico técnico al mes', '10% de descuento en servicios del hogar', 'Soporte por chat IA prioritario'] },
  { nombre: 'Hogar+', precio: 1990, destacado: true, items: ['1 limpieza profunda al mes', '1 mantenimiento de A/A por trimestre', '15% de descuento en técnicos', 'Atención el mismo día'] },
  { nombre: 'Empresa', precio: 4500, items: ['4 visitas de soporte técnico al mes', '1 consulta contable mensual', 'Facturas con crédito fiscal (e31)', 'Ejecutivo de cuenta'] },
]
