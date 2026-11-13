#!/usr/bin/env bash
# =====================================================================
# Configuración inicial de Google Cloud (se ejecuta UNA vez, en Cloud Shell).
#   1. Edita las 3 variables de abajo.
#   2. En Cloud Shell:  bash despliegue/configurar-gcp.sh
# Crea: APIs, Artifact Registry, bucket, Cloud SQL (SQL Server Express, IP privada),
# cuentas de servicio con permisos mínimos, secretos y Workload Identity Federation para GitHub.
# Se puede volver a ejecutar: lo que ya existe se deja como está.
# =====================================================================
set -euo pipefail

PROYECTO="gestion-servicios-514611"   # id del proyecto de Google Cloud
REPO_GITHUB="doreinycod/gestion-servicios-gcp" # dueño/repositorio en GitHub
REGION="us-east1"

SERVICIO="gestion-servicios"
SQL_INSTANCIA="gestion-sql"
BUCKET="${PROYECTO}-gestion-datos"
SA_APP="app-gestion"
SA_BUILD="cloudbuild-gestion"
SA_GITHUB="github-gestion"

gcloud config set project "$PROYECTO"
NUM_PROYECTO=$(gcloud projects describe "$PROYECTO" --format='value(projectNumber)')
existe() { "$@" >/dev/null 2>&1; }

echo "▶ 1/8 Activando APIs…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com servicenetworking.googleapis.com compute.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudscheduler.googleapis.com

echo "▶ 2/8 Artifact Registry (imágenes Docker)…"
existe gcloud artifacts repositories describe "$SERVICIO" --location "$REGION" || \
  gcloud artifacts repositories create "$SERVICIO" --repository-format=docker --location "$REGION" \
    --description "Imágenes de Gestión de Servicios"

echo "▶ 3/8 Bucket de archivos (adjuntos y XML de e-CF)…"
existe gcloud storage buckets describe "gs://$BUCKET" || \
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention

echo "▶ 4/8 Red privada hacia Cloud SQL…"
existe gcloud compute addresses describe google-managed-services-default --global || \
  gcloud compute addresses create google-managed-services-default --global --purpose=VPC_PEERING --prefix-length=16 --network=default
gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-default --network=default 2>/dev/null || echo "  (la conexión privada ya existía)"

echo "▶ 5/8 Cloud SQL para SQL Server (Express, IP privada)…"
if ! existe gcloud sql instances describe "$SQL_INSTANCIA"; then
  read -r -s -p "  Contraseña para el usuario 'sqlserver' de la base (mín. 12 caracteres): " SQL_PASS; echo
  gcloud sql instances create "$SQL_INSTANCIA" --database-version=SQLSERVER_2022_EXPRESS --edition=ENTERPRISE \
    --tier=db-custom-1-3840 --region="$REGION" --network=default --no-assign-ip \
    --storage-size=20 --storage-auto-increase --backup-start-time=06:00 --root-password="$SQL_PASS" \
    --time-zone="SA Western Standard Time"
  printf '%s' "$SQL_PASS" | gcloud secrets create db-password --data-file=- 2>/dev/null || \
    printf '%s' "$SQL_PASS" | gcloud secrets versions add db-password --data-file=-
fi
echo "  IP privada de Cloud SQL (ponla en DB_SERVER de despliegue/cloudrun.env.yaml):"
gcloud sql instances describe "$SQL_INSTANCIA" --format='value(ipAddresses[0].ipAddress)'

echo "▶ 6/8 Cuentas de servicio y permisos…"
for sa in "$SA_APP:Aplicación en Cloud Run" "$SA_BUILD:Cloud Build (construye y despliega)" "$SA_GITHUB:GitHub Actions"; do
  existe gcloud iam service-accounts describe "${sa%%:*}@$PROYECTO.iam.gserviceaccount.com" || \
    gcloud iam service-accounts create "${sa%%:*}" --display-name "${sa#*:}"
done
rol() { gcloud projects add-iam-policy-binding "$PROYECTO" --member "serviceAccount:$1@$PROYECTO.iam.gserviceaccount.com" --role "$2" --condition=None >/dev/null; }
usar_sa() { gcloud iam service-accounts add-iam-policy-binding "$2@$PROYECTO.iam.gserviceaccount.com" --member "serviceAccount:$1@$PROYECTO.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser >/dev/null; }
# Aplicación: leer secretos y usar el bucket
rol "$SA_APP" roles/secretmanager.secretAccessor
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_APP@$PROYECTO.iam.gserviceaccount.com" --role roles/storage.objectAdmin >/dev/null
# Cloud Build: subir imágenes, desplegar en Cloud Run como la cuenta de la aplicación, escribir logs, leer el código subido
rol "$SA_BUILD" roles/run.admin
rol "$SA_BUILD" roles/artifactregistry.writer
rol "$SA_BUILD" roles/logging.logWriter
rol "$SA_BUILD" roles/storage.objectViewer
rol "$SA_BUILD" roles/compute.networkViewer   # Cloud Run con salida directa a la VPC (Cloud SQL privado)
usar_sa "$SA_BUILD" "$SA_APP"
# GitHub Actions: lanzar builds con la cuenta de Cloud Build, subir el código, ver logs y el servicio
rol "$SA_GITHUB" roles/cloudbuild.builds.editor
rol "$SA_GITHUB" roles/serviceusage.serviceUsageConsumer
rol "$SA_GITHUB" roles/storage.admin
rol "$SA_GITHUB" roles/logging.viewer
rol "$SA_GITHUB" roles/run.viewer
usar_sa "$SA_GITHUB" "$SA_BUILD"

echo "▶ 7/8 Secretos (Secret Manager)…"
secreto() {
  if existe gcloud secrets describe "$1"; then echo "  $1 ya existe (para cambiarlo: gcloud secrets versions add $1 --data-file=-)"; return; fi
  read -r -s -p "  $2: " VALOR; echo
  printf '%s' "${VALOR:-sin-configurar}" | gcloud secrets create "$1" --data-file=-
}
existe gcloud secrets describe jwt-secret || openssl rand -base64 48 | tr -d '\n' | gcloud secrets create jwt-secret --data-file=-
# Clave con la que Cloud Scheduler llama a /api/tareas (la genera el script; nadie la necesita escribir)
existe gcloud secrets describe tareas-token || openssl rand -hex 32 | tr -d '\n' | gcloud secrets create tareas-token --data-file=-
secreto ecf-api-key "Clave de la plataforma e-CF (ECF_API_KEY)"
secreto gemini-api-key "Clave de Gemini (GEMINI_API_KEY)"
secreto paypal-client-secret "Secreto de PayPal (PAYPAL_CLIENT_SECRET; Enter para dejar PayPal simulado)"

echo "▶ 8/8 Workload Identity Federation para GitHub Actions…"
existe gcloud iam workload-identity-pools describe github --location=global || \
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
existe gcloud iam workload-identity-pools providers describe github-oidc --location=global --workload-identity-pool=github || \
  gcloud iam workload-identity-pools providers create-oidc github-oidc --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${REPO_GITHUB}'"
gcloud iam service-accounts add-iam-policy-binding "$SA_GITHUB@$PROYECTO.iam.gserviceaccount.com" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUM_PROYECTO/locations/global/workloadIdentityPools/github/attribute.repository/${REPO_GITHUB}" >/dev/null

cat <<FIN

✅ Listo. En GitHub → Settings → Secrets and variables → Actions → pestaña "Variables", crea:
   GCP_PROJECT_ID    = $PROYECTO
   GCP_REGION        = $REGION
   GCP_WIF_PROVIDER  = projects/$NUM_PROYECTO/locations/global/workloadIdentityPools/github/providers/github-oidc
   GCP_SA_GITHUB     = $SA_GITHUB@$PROYECTO.iam.gserviceaccount.com
Y en Settings → Environments crea el entorno "produccion".
Siguiente: importar la base de datos (ver DESPLIEGUE.md, paso 4).
FIN
