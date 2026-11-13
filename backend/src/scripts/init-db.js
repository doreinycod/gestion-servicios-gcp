// Aplica en orden los scripts de database/ sobre GestionMultiservicios (todos idempotentes).
import fs from 'node:fs/promises'
import path from 'node:path'
import { getPool } from '../config/db.js'

const dir = path.resolve('database')
const archivos = (await fs.readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
const pool = await getPool()
for (const archivo of archivos) {
  const lotes = (await fs.readFile(path.join(dir, archivo), 'utf8'))
    .split(/^\s*GO\s*$/gim)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const lote of lotes) await pool.request().batch(lote)
  console.log(`✓ ${archivo} (${lotes.length} lotes)`)
}
await pool.close()
console.log('Ajustes aplicados.')
