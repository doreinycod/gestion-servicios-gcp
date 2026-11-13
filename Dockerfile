# Imagen única para Cloud Run: el backend (Express) sirve la API en /api y el frontend compilado (React) en /.

# --- Etapa 1: compila el frontend (Vite) ---
FROM node:24-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# --- Etapa 2: dependencias de producción del backend ---
FROM node:24-alpine AS dependencias
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# --- Etapa 3: imagen final ---
FROM node:24-alpine
RUN apk add --no-cache tzdata
# Cloud Run indica el puerto en PORT (8080); HOST=0.0.0.0 para aceptar conexiones de fuera del contenedor
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TZ=America/Santo_Domingo \
    FRONTEND_DIR=/app/public
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/database ./database
COPY --from=frontend /src/dist ./public
# Carpetas de archivos para uso local; en Cloud Run se usa el bucket montado en DATOS_DIR
RUN mkdir -p uploads storage/ecf && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
