// Borra los datos transaccionales (solicitudes, pagos, facturas, e-CF, IA, notificaciones, bitácora)
// y reinicia las secuencias e-NCF. Conserva usuarios, prestadores, catálogo y planes.
// Uso solo en desarrollo: npm run db:limpiar -- --confirmar
import fs from 'node:fs/promises'
import path from 'node:path'
import { getPool } from '../config/db.js'
import { DIR_ECF, DIR_UPLOADS } from '../config/rutas.js'

if (!process.argv.includes('--confirmar')) {
  console.error('Este script borra solicitudes, pagos y facturas. Ejecútelo con --confirmar')
  process.exit(1)
}
const TABLAS = ['paypal_webhooks', 'paypal_transacciones', 'ecf', 'factura_detalle', 'solicitudes_nota_credito', 'facturas', 'pagos', 'cargos_adicionales', 'asignaciones_servicio',
  'solicitud_detalle', 'solicitudes_servicio', 'ia_sugerencias', 'ia_mensajes', 'ia_conversaciones', 'notificaciones', 'bitacora']
const pool = await getPool()
for (const t of TABLAS) {
  await pool.request().batch(`DELETE FROM ${t}; DBCC CHECKIDENT ('${t}', RESEED, 0) WITH NO_INFOMSGS;`)
}
await pool.request().batch("UPDATE secuencias_ecf SET ultimo_usado = desde - 1, estado = 'Vigente'")
for (const dir of [DIR_ECF, DIR_UPLOADS]) {
  for (const f of await fs.readdir(dir).catch(() => [])) if (f !== '.gitkeep') await fs.rm(path.join(dir, f), { force: true })
}
await pool.close()
console.log('Datos transaccionales borrados y secuencias e-NCF reiniciadas.')
