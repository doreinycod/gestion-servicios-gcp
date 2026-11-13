#!/usr/bin/env bash
# =====================================================================
# Cloud Scheduler: dispara las tareas programadas del sistema llamando a Cloud Run.
# Se ejecuta UNA vez en Cloud Shell, DESPUÉS del primer despliegue (necesita la URL del servicio).
#   bash despliegue/programar-tareas.sh
# Con esto Cloud Run puede quedar en 0 instancias: cuando toca una tarea, Scheduler hace la petición,
# Cloud Run levanta una instancia, la tarea corre y la instancia vuelve a apagarse si no hay más tráfico.
# =====================================================================
set -euo pipefail

PROYECTO="mi-proyecto-gcp"   # CAMBIAR: el mismo de configurar-gcp.sh
REGION="us-east1"
SERVICIO="gestion-servicios"

gcloud config set project "$PROYECTO"
URL=$(gcloud run services describe "$SERVICIO" --region "$REGION" --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret=tareas-token)
echo "Servicio: $URL"

# nombre | frecuencia (cron, hora de RD) | descripción
# Cada 30 min y en el mismo minuto: Cloud Run apaga una instancia inactiva tras ~15 min, así que entre
# una corrida y la siguiente el servicio sí baja a 0 instancias (con cada 5 min nunca llegaría a 0).
programar() {
  local nombre="tareas-$1" args=(--location "$REGION" --schedule "$2" --time-zone "America/Santo_Domingo"
    --uri "$URL/api/tareas/$1" --http-method POST --attempt-deadline 300s --description "$3")
  if gcloud scheduler jobs describe "$nombre" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$nombre" "${args[@]}" --update-headers "X-Tareas-Token=$TOKEN" >/dev/null
  else
    gcloud scheduler jobs create http "$nombre" "${args[@]}" --headers "X-Tareas-Token=$TOKEN" >/dev/null
  fi
  echo "  ✓ $nombre · $2 · $3"
}

programar frecuentes "*/30 * * * *"  "Asignaciones vencidas (2 h), confirmación automática (48 h), chats inactivos"
programar dgii       "*/30 * * * *"  "Reintento de e-CF en proceso o sin emitir"
programar horarias   "0 * * * *"    "Suscripciones vencidas"
programar secuencias "0 */6 * * *"  "Secuencias e-NCF por agotarse o vencer"

echo "Listo. Puedes probar una tarea a mano con:  gcloud scheduler jobs run tareas-frecuentes --location $REGION"
