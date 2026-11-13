# Despliegue en Google Cloud

```
GitHub (push a main)
   └─▶ GitHub Actions ── lint + build ──▶ Cloud Build ──▶ Artifact Registry (imagen Docker)
                                              └──────────▶ Cloud Run (gestion-servicios)
                                                             ├─ /api  → backend Express
                                                             ├─ /     → frontend React compilado
                                                             ├─ /datos → bucket de Cloud Storage (adjuntos y XML)
                                                             ├─ Secret Manager (claves)
                                                             └─ Cloud SQL para SQL Server (IP privada)
```

| Pieza | Archivo | Qué hace |
|---|---|---|
| Docker | `Dockerfile`, `.dockerignore` | Una sola imagen: compila el frontend y lo sirve el mismo backend (una URL, sin CORS). |
| Cloud Build | `cloudbuild.yaml` | Construye la imagen, la sube a Artifact Registry y despliega en Cloud Run. |
| Cloud Run | `despliegue/cloudrun.env.yaml` | Variables sin secretos del servicio. Los secretos vienen de Secret Manager. |
| GitHub Actions | `.github/workflows/despliegue.yml` | En cada pull request: lint y build. En cada push a `main`: además despliega. |
| Configuración inicial | `despliegue/configurar-gcp.sh` | Crea en Google Cloud todo lo anterior (se ejecuta una vez). |

## 1. Subir el proyecto a GitHub

1. Crea un repositorio **privado** vacío en GitHub (por ejemplo, `GestionServicios`).
2. En la carpeta del proyecto:
   ```bash
   git init -b main
   git add .
   git status            # comprueba que NO aparezcan backend/.env, uploads ni storage
   git commit -m "Proyecto inicial"
   git remote add origin https://github.com/USUARIO/GestionServicios.git
   git push -u origin main
   ```
   El primer push corre la verificación; el despliegue fallará hasta completar el paso 3. Es normal.

> `backend/.env` tiene tus claves reales y está excluido en `.gitignore`. Si alguna vez se sube por error, cambia todas las claves.

## 2. Configurar Google Cloud (una vez)

1. Crea un proyecto en <https://console.cloud.google.com> y activa la facturación.
2. Abre **Cloud Shell** (el ícono `>_` arriba a la derecha) y clona el repositorio:
   ```bash
   git clone https://github.com/USUARIO/GestionServicios.git && cd GestionServicios
   ```
3. Edita las 3 variables del inicio de `despliegue/configurar-gcp.sh` (`PROYECTO`, `REPO_GITHUB`, `REGION`) y ejecútalo:
   ```bash
   bash despliegue/configurar-gcp.sh
   ```
   Te pedirá la contraseña de la base y las claves (plataforma e-CF, Gemini, PayPal). Crear Cloud SQL tarda unos 10 a 15 minutos.
4. Al final muestra la **IP privada de Cloud SQL** y 4 variables para GitHub.

## 3. Conectar GitHub con Google Cloud

En GitHub → **Settings → Secrets and variables → Actions → Variables**, crea las 4 variables que mostró el script:
`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER` y `GCP_SA_GITHUB`.

Luego, en **Settings → Environments**, crea el entorno `produccion`. Ahí puedes exigir una aprobación antes de cada despliegue.

No se guarda ninguna clave de Google en GitHub: la conexión usa Workload Identity Federation y solo funciona desde tu repositorio.

## 4. Migrar la base de datos a Cloud SQL

Tu SQL Server local es la versión **2025**. Un respaldo `.bak` de 2025 no se restaura en Cloud SQL 2022, así que se migra con scripts:

1. En **SSMS**, clic derecho en `GestionMultiservicios` → **Tareas → Generar scripts** → toda la base.
   En **Avanzado**: *Script for Server Version* = **SQL Server 2022** y *Types of data to script* = **Schema and data**. Guárdalo como `gestion.sql`.
2. Abre temporalmente el acceso público a la instancia solo para tu IP:
   ```bash
   gcloud sql instances patch gestion-sql --assign-ip --authorized-networks=TU_IP_PUBLICA/32
   gcloud sql instances describe gestion-sql --format='value(ipAddresses)'   # IP pública
   ```
3. En SSMS, conéctate a esa IP pública (usuario `sqlserver`), crea la base `GestionMultiservicios` y ejecuta `gestion.sql`.
4. Cierra el acceso público:
   ```bash
   gcloud sql instances patch gestion-sql --no-assign-ip --clear-authorized-networks
   ```

> Si Cloud SQL ya ofrece SQL Server 2025 en tu región, puedes crear la instancia con esa versión (cambia `SQLSERVER_2022_EXPRESS` en el script). En ese caso puedes subir el `.bak` al bucket y usar `gcloud sql import bak`.

Los adjuntos y XML que ya tienes (`backend/uploads`, `backend/storage`) se copian al bucket así:

```bash
gcloud storage cp -r backend/uploads backend/storage gs://PROYECTO-gestion-datos/
```

## 5. Primer despliegue

1. En `despliegue/cloudrun.env.yaml` pon la **IP privada** en `DB_SERVER` y tu `PAYPAL_CLIENT_ID`.
2. Haz push a `main`. En GitHub → **Actions** verás *Verificar* y luego *Desplegar en Cloud Run*. Al terminar, el resumen muestra la URL (`https://gestion-servicios-xxxxx.us-east1.run.app`).
3. Pon esa URL en `FRONTEND_URL` y `CORS_ORIGIN` del mismo archivo y vuelve a hacer push. Esa URL se usa en los enlaces de PayPal y de recuperar contraseña.
4. Actualiza las URL externas:
   - **Webhook de PayPal:** `https://TU_URL/api/webhooks/paypal`.
   - **Plataforma e-CF:** si te pide una URL de retorno, la misma base.
5. Comprueba que todo responde: `https://TU_URL/api/salud` debe devolver `"ok": true` con el nombre de la base.

6. **Programa las tareas** (una vez, en Cloud Shell): edita `PROYECTO` en `despliegue/programar-tareas.sh` y ejecútalo.
   ```bash
   bash despliegue/programar-tareas.sh
   ```
   Crea 4 trabajos en **Cloud Scheduler**:
   - cada 30 min: plazos de asignación y de confirmación, y reintentos a la DGII;
   - cada hora: suscripciones vencidas;
   - cada 6 h: secuencias e-NCF.

Desde aquí, **cada push a `main` despliega solo**. Para volver a una versión anterior: Cloud Run → servicio → **Revisiones** → elegir una → *Administrar tráfico*.

## Notas de operación

- **Instancias (escalado automático):** mínimo **0** y máximo **3** (`cloudbuild.yaml`).
  - **Sin peticiones** → 0 instancias: no hay contenedor encendido y no se paga CPU ni memoria.
  - **Llega una petición** → Cloud Run levanta una instancia (*arranque en frío* de unos segundos la primera vez) y la mantiene ~15 min mientras haya uso.
  - **Mucho tráfico** → cada instancia atiende hasta 80 peticiones a la vez (`--concurrency=80`); si no alcanza, se levantan más, hasta 3.
  - **CPU solo durante las peticiones** (`--cpu-throttling`): se cobra únicamente el tiempo que atiende.
- **Tareas programadas:** como el servicio puede estar en 0, no corren dentro del servidor (`TAREAS=off`). Las dispara **Cloud Scheduler** llamando a `POST /api/tareas/...` con una clave secreta. Esa llamada levanta una instancia si hace falta.
- **Secretos:** se cambian sin tocar el código.
  ```bash
  printf 'NUEVO_VALOR' | gcloud secrets versions add gemini-api-key --data-file=-
  ```
  Luego vuelve a desplegar.
  Para agregar uno nuevo (por ejemplo `SMTP_PASS` o `ANTHROPIC_API_KEY`): créalo con `gcloud secrets create` y agrégalo a `--update-secrets` en `cloudbuild.yaml`.
- **Costos aproximados:**
  - **Cloud SQL Express** (1 vCPU, 3.75 GB): ~US$ 50/mes. Es lo más caro; no se apaga solo.
  - **Cloud Run** escalando a 0: centavos a pocos dólares, porque solo cobra mientras atiende. La capa gratuita cubre 2 millones de peticiones al mes.
  - **Cloud Scheduler:** gratis (3 trabajos gratis; el 4.º cuesta US$ 0.10/mes).
  - **Storage y Artifact Registry:** centavos.
- **Logs:** Cloud Run → servicio → **Registros**. Ahí salen los mismos mensajes que ves hoy en la consola del backend.
