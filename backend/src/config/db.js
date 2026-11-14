import 'dotenv/config'
import sql from 'mssql'

// Conexión a SQL Server (base GestionMultiservicios).
// Las consultas se escriben con marcadores "?" que se convierten en parámetros @p0, @p1…
// (consultas parametrizadas: evitan inyección SQL, sección 25.3).
const config = {
  server: process.env.DB_SERVER || 'localhost',
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE || 'GestionMultiservicios',
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || '',
  // Cloud SQL: DB_ENCRYPT=true cifra la conexión (TLS); en local queda sin cifrar como antes
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true', trustServerCertificate: process.env.DB_TRUST_CERT !== 'false', useUTC: false,
    // Node 26+ no acepta una IP como nombre TLS (Cloud SQL se conecta por IP privada); el certificado ya se confía
    ...(/^\d+\.\d+\.\d+\.\d+$/.test(process.env.DB_SERVER || '') ? { serverName: 'cloudsql' } : {}),
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
}

let poolPromise = null
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect().catch((e) => {
      poolPromise = null
      throw e
    })
  }
  return poolPromise
}

/** Convierte "?" en @pN. Un arreglo se expande en lista (para IN (?)). */
function preparar(texto, params) {
  const entradas = []
  let i = 0
  const out = texto.replace(/\?/g, () => {
    const v = params[i++]
    if (Array.isArray(v)) {
      if (!v.length) return 'NULL'
      return v.map((x) => { entradas.push(x); return `@p${entradas.length - 1}` }).join(', ')
    }
    entradas.push(v)
    return `@p${entradas.length - 1}`
  })
  if (i !== params.length) throw new Error(`Parámetros SQL: se esperaban ${i}, llegaron ${params.length}`)
  return { out, entradas }
}

const pad = (n) => String(n).padStart(2, '0')

/** DATE → 'yyyy-mm-dd' y TIME → 'HH:MM' para que el frontend no reciba fechas con zona horaria. */
function normalizar(recordset) {
  if (!recordset?.columns) return recordset || []
  const fechas = [], horas = []
  for (const [nombre, c] of Object.entries(recordset.columns)) {
    if (c.type === sql.Date) fechas.push(nombre)
    if (c.type === sql.Time) horas.push(nombre)
  }
  if (!fechas.length && !horas.length) return recordset
  for (const r of recordset) {
    for (const f of fechas) if (r[f] instanceof Date) r[f] = `${r[f].getFullYear()}-${pad(r[f].getMonth() + 1)}-${pad(r[f].getDate())}`
    for (const h of horas) if (r[h] instanceof Date) r[h] = `${pad(r[h].getUTCHours())}:${pad(r[h].getUTCMinutes())}`
  }
  return recordset
}

async function ejecutar(texto, params, cx) {
  const { out, entradas } = preparar(texto, params)
  const req = cx ? new sql.Request(cx) : (await getPool()).request()
  entradas.forEach((v, n) => {
    if (typeof v === 'number' && !Number.isInteger(v)) req.input(`p${n}`, sql.Decimal(18, 4), v)
    else req.input(`p${n}`, v === undefined ? null : v)
  })
  try {
    return await req.query(out)
  } catch (e) {
    e.sql = out.replace(/\s+/g, ' ').slice(0, 600) // para el registro de errores del servidor
    throw e
  }
}

/** SELECT: devuelve las filas. `cx` es la transacción activa (opcional). */
export async function query(texto, params = [], cx) {
  const r = await ejecutar(texto, params, cx)
  return normalizar(r.recordset)
}

export async function one(texto, params = [], cx) {
  return (await query(texto, params, cx))[0] || null
}

/** INSERT/UPDATE/DELETE. En INSERT devuelve insertId (SCOPE_IDENTITY). */
export async function exec(texto, params = [], cx) {
  const esInsert = /^\s*INSERT\s/i.test(texto)
  const r = await ejecutar(esInsert ? `${texto}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS insertId;` : texto, params, cx)
  return { insertId: esInsert ? r.recordset?.[0]?.insertId ?? null : null, affectedRows: r.rowsAffected?.[0] ?? 0 }
}

/** Ejecuta fn(tx) en una transacción; revierte si lanza un error. */
export async function transaction(fn) {
  const tx = new sql.Transaction(await getPool())
  await tx.begin()
  try {
    const r = await fn(tx)
    await tx.commit()
    return r
  } catch (e) {
    try { await tx.rollback() } catch { /* ya revertida */ }
    throw e
  }
}

export async function verificarConexion() {
  return one('SELECT @@VERSION AS version, DB_NAME() AS db')
}

// Fragmentos T-SQL reutilizables
export const HOY = 'CAST(GETDATE() AS date)'
export const AHORA = 'SYSDATETIME()'
