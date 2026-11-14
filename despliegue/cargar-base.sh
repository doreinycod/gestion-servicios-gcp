#!/usr/bin/env bash
# =====================================================================
# Carga la base GestionMultiservicios en Cloud SQL desde Cloud Shell (dentro de Google,
# sin depender del puerto 1433 de tu proveedor de internet).
#   1. Abre la IP pública de Cloud SQL SOLO para la IP de Cloud Shell.
#   2. Crea la base (intercalación Modern_Spanish_CI_AS) y carga tablas, datos e índices
#      desde gs://BUCKET/migracion/ (gestion.sql y gestion-indices.sql).
#   3. Verifica tablas, filas e índices.
#   4. Cierra la IP pública (también si algo falla).
# Uso en Cloud Shell:  bash cargar-base.sh
# =====================================================================
set -euo pipefail

PROYECTO="gestion-servicios-514611"
INSTANCIA="gestion-sql"
BUCKET="gs://${PROYECTO}-gestion-datos/migracion"

gcloud config set project "$PROYECTO" >/dev/null

cerrar() {
  echo "▶ Cerrando la IP pública de Cloud SQL…"
  gcloud sql instances patch "$INSTANCIA" --no-assign-ip --clear-authorized-networks --quiet >/dev/null 2>&1 \
    && echo "  ✓ Cloud SQL vuelve a ser solo privada" || echo "  ⚠ No se pudo cerrar: ejecútalo a mano (ver DESPLIEGUE.md)"
}
trap cerrar EXIT

MI_IP=$(curl -s https://api.ipify.org)
echo "▶ 1/4 Abriendo Cloud SQL solo para Cloud Shell ($MI_IP)… (1 a 3 min)"
gcloud sql instances patch "$INSTANCIA" --assign-ip --authorized-networks="$MI_IP/32" --quiet >/dev/null
IP_PUBLICA=$(gcloud sql instances describe "$INSTANCIA" --format=json | python3 -c "import json,sys; print(next(a['ipAddress'] for a in json.load(sys.stdin)['ipAddresses'] if a['type']=='PRIMARY'))")
echo "  IP pública de Cloud SQL: $IP_PUBLICA"

echo "▶ 2/4 Descargando los scripts y la librería de conexión…"
DIR=$(mktemp -d)
gcloud storage cp "$BUCKET/gestion.sql" "$BUCKET/gestion-indices.sql" "$DIR/" >/dev/null
cd "$DIR"
npm init -y >/dev/null 2>&1
npm install mssql@11 --silent --no-audit --no-fund >/dev/null 2>&1

cat > cargar.mjs <<'NODE'
import fs from 'node:fs'
import sql from 'mssql'

const base = { server: process.env.IP_PUBLICA, port: 1433, user: 'sqlserver', password: process.env.DB_PASSWORD,
  // serverName: Node 26 no acepta una IP como nombre TLS; con trustServerCertificate el nombre no se valida
  options: { encrypt: true, trustServerCertificate: true, serverName: 'gestion-sql' }, requestTimeout: 300000, connectionTimeout: 30000,
  pool: { max: 1, min: 1 } } // una sola conexión: USE e IDENTITY_INSERT se conservan entre lotes
const lotes = (archivo) => fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '').split(/^\s*GO\s*$/gim).map((l) => l.trim()).filter(Boolean)

const maestro = await new sql.ConnectionPool({ ...base, database: 'master' }).connect()
const existe = (await maestro.request().query("SELECT DB_ID('GestionMultiservicios') AS id")).recordset[0].id
if (!existe) {
  await maestro.request().batch('CREATE DATABASE GestionMultiservicios COLLATE Modern_Spanish_CI_AS')
  console.log('  ✓ Base creada (Modern_Spanish_CI_AS)')
}
await maestro.close()

const db = await new sql.ConnectionPool({ ...base, database: 'GestionMultiservicios' }).connect()
const tablas = (await db.request().query('SELECT COUNT(*) AS n FROM sys.tables WHERE is_ms_shipped = 0')).recordset[0].n
if (tablas > 0) {
  console.log(`  ⚠ La base ya tiene ${tablas} tablas: no se vuelve a cargar (evita datos duplicados).`)
} else {
  const l = lotes('gestion.sql')
  console.log(`▶ 3/4 Cargando tablas y datos (${l.length} lotes)…`)
  for (const [i, lote] of l.entries()) {
    try { await db.request().batch(lote) } catch (e) {
      console.error(`  ✗ Error en el lote ${i + 1}: ${e.message}\n${lote.slice(0, 300)}`)
      process.exit(1)
    }
    if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${l.length}`)
  }
  for (const lote of lotes('gestion-indices.sql')) await db.request().batch(lote)
  console.log('  ✓ Tablas, datos e índices cargados')
}

const r = (await db.request().query(`SELECT
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS tablas,
  (SELECT SUM(p.rows) FROM sys.partitions p JOIN sys.tables t ON t.object_id = p.object_id WHERE p.index_id IN (0,1)) AS filas,
  (SELECT COUNT(*) FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE i.type > 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0) AS indices,
  (SELECT COUNT(*) FROM sys.foreign_keys) AS llaves, (SELECT COUNT(*) FROM sys.check_constraints) AS checks,
  CONVERT(varchar(60), DATABASEPROPERTYEX('GestionMultiservicios', 'Collation')) AS intercalacion`)).recordset[0]
console.log('▶ 4/4 Verificación (esperado: 32 tablas · 1318 filas · 45 índices · 57 llaves · 83 checks · Modern_Spanish_CI_AS)')
console.log(`  ${r.tablas} tablas · ${r.filas} filas · ${r.indices} índices · ${r.llaves} llaves · ${r.checks} checks · ${r.intercalacion}`)
const ok = r.tablas === 32 && Number(r.filas) === 1318 && r.indices === 45 && r.llaves === 57 && r.checks === 83
console.log(ok ? '\n✅ La base quedó igual que la local.' : '\n⚠ Algo no coincide: copia este resultado y envíalo.')
await db.close()
NODE

DB_PASSWORD=$(gcloud secrets versions access latest --secret=db-password) IP_PUBLICA="$IP_PUBLICA" node cargar.mjs
