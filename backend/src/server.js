import 'dotenv/config'
import { app } from './app.js'
import { verificarConexion } from './config/db.js'
import { iniciarTareas } from './jobs.js'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)

try {
  const db = await verificarConexion()
  console.log(`✓ Conectado a SQL Server · base ${db.db}`)
} catch (e) {
  console.error(`✗ No se pudo conectar a SQL Server (${process.env.DB_SERVER}:${process.env.DB_PORT}/${process.env.DB_DATABASE}): ${e.message}`)
  process.exit(1)
}

app.listen(PORT, HOST, () => {
  console.log(`✓ API escuchando en http://${HOST}:${PORT}/api`)
  // TAREAS=off desactiva las tareas programadas (por ejemplo, en instancias adicionales)
  if (process.env.TAREAS !== 'off') iniciarTareas()
})
